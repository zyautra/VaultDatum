package io.vaultdatum.server.api;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHash;
import io.vaultdatum.server.sync.BaseStateMismatchException;
import io.vaultdatum.server.sync.CreateCoordinator;
import io.vaultdatum.server.sync.CreateBase;
import io.vaultdatum.server.sync.CreateOperation;
import io.vaultdatum.server.sync.CreateOperationResult;
import io.vaultdatum.server.sync.DeletedCreateBase;
import io.vaultdatum.server.sync.ModifyCoordinator;
import io.vaultdatum.server.sync.ModifyOperation;
import io.vaultdatum.server.sync.OperationResult;
import io.vaultdatum.server.sync.OperationIdReuseException;
import io.vaultdatum.server.sync.PresentBase;
import io.vaultdatum.server.sync.RecoveryRequiredException;
import io.vaultdatum.server.sync.RevisionNotificationPublisher;
import io.vaultdatum.server.sync.SyncPath;
import io.vaultdatum.server.sync.UnknownCreateBase;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import org.jboss.resteasy.reactive.RestForm;
import org.jboss.resteasy.reactive.multipart.FileUpload;

import java.io.IOException;
import java.nio.file.Files;

@Path("/api/v1/operations")
@Consumes(MediaType.MULTIPART_FORM_DATA)
@Produces(MediaType.APPLICATION_JSON)
public final class OperationResource {

    private final ObjectMapper objectMapper;

    private final DataDirectories dataDirectories;

    private final CreateCoordinator createCoordinator;

    private final ModifyCoordinator modifyCoordinator;

    private final RevisionNotificationPublisher notificationPublisher;

    public OperationResource(
            ObjectMapper objectMapper,
            DataDirectories dataDirectories,
            CreateCoordinator createCoordinator,
            ModifyCoordinator modifyCoordinator,
            RevisionNotificationPublisher notificationPublisher) {
        this.objectMapper = objectMapper;
        this.dataDirectories = dataDirectories;
        this.createCoordinator = createCoordinator;
        this.modifyCoordinator = modifyCoordinator;
        this.notificationPublisher = notificationPublisher;
    }

    @POST
    public Response submitContentMutation(
            @RestForm("operation") String serializedOperation,
            @RestForm("content") FileUpload uploadedContent) {
        ContentMutationRequest request;

        try {
            request = parse(serializedOperation);
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST.getStatusCode(), "INVALID_REQUEST", exception.getMessage());
        }
        if (uploadedContent == null) {
            return error(Response.Status.BAD_REQUEST.getStatusCode(), "INVALID_REQUEST", "Content is required for this operation.");
        }

        java.nio.file.Path stagedContent = null;
        try {
            stagedContent = Files.createTempFile(dataDirectories.staging(), "upload-", ".tmp");
            ContentHash.HashedContent actualContent = ContentHash.copy(uploadedContent.uploadedFile(), stagedContent);

            if (request.content() == null || !actualContent.value().equals(request.content().contentHash())
                    || actualContent.size() != request.content().size()) {
                Files.deleteIfExists(stagedContent);
                return error(422, "CONTENT_HASH_MISMATCH",
                        "Uploaded content does not match the declared hash and size.");
            }

            if ("CREATE".equals(request.type())) {
                CreateOperation operation = createOperation(request, actualContent);
                CreateOperationResult result = createCoordinator.commit(operation, stagedContent);
                discardReplayUpload(result.replayed(), stagedContent);
                publishRevision(result.replayed(), result.resultRevision());
                return Response.ok(response(result)).build();
            }
            if ("MODIFY".equals(request.type())) {
                ModifyOperation operation = modifyOperation(request, actualContent);
                OperationResult result = modifyCoordinator.commit(operation, stagedContent);
                discardReplayUpload(result.replayed(), stagedContent);
                publishRevision(result.replayed(), result.resultRevision());
                return Response.ok(response(result)).build();
            }

            return error(Response.Status.BAD_REQUEST.getStatusCode(), "INVALID_REQUEST",
                    "Only CREATE and MODIFY content operations are supported");
        } catch (BaseStateMismatchException exception) {
            deleteIfPresent(stagedContent);
            return error(Response.Status.CONFLICT.getStatusCode(), "BASE_STATE_MISMATCH", exception.getMessage());
        } catch (OperationIdReuseException exception) {
            deleteIfPresent(stagedContent);
            return error(Response.Status.CONFLICT.getStatusCode(), "OPERATION_ID_REUSED", exception.getMessage());
        } catch (RecoveryRequiredException exception) {
            return error(Response.Status.SERVICE_UNAVAILABLE.getStatusCode(), "RECOVERY_REQUIRED", exception.getMessage());
        } catch (IllegalArgumentException exception) {
            deleteIfPresent(stagedContent);
            return error(Response.Status.BAD_REQUEST.getStatusCode(), "INVALID_REQUEST", exception.getMessage());
        } catch (IOException exception) {
            deleteIfPresent(stagedContent);
            throw new IllegalStateException("Could not create staging file", exception);
        }
    }

    private static void deleteIfPresent(java.nio.file.Path content) {
        if (content == null) {
            return;
        }

        try {
            Files.deleteIfExists(content);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not discard uncommitted staged content", exception);
        }
    }

    private void publishRevision(boolean replayed, long revision) {
        if (!replayed) {
            notificationPublisher.publish(revision);
        }
    }

    private static void discardReplayUpload(boolean replayed, java.nio.file.Path stagedContent) {
        if (replayed) {
            deleteIfPresent(stagedContent);
        }
    }

    private ContentMutationRequest parse(String serializedOperation) {
        try {
            return objectMapper.readValue(serializedOperation, ContentMutationRequest.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Operation metadata must be valid JSON", exception);
        }
    }

    private CreateOperation createOperation(
            ContentMutationRequest request,
            ContentHash.HashedContent actualContent) {
        if (request == null || !"CREATE".equals(request.type()) || request.content() == null
                || request.base() == null || request.base().length != 1) {
            throw new IllegalArgumentException("A CREATE operation requires one base condition");
        }

        SyncPath path = SyncPath.parse(request.path());
        validateCommon(request, path);
        CreateBase base = createBase(request.base()[0]);
        if (request.content().size() != actualContent.size() || !request.content().contentHash().equals(actualContent.value())) {
            throw new IllegalArgumentException("CREATE content metadata is invalid");
        }

        return new CreateOperation(
                request.operationId(), request.clientId(), path, base, request.content().contentHash(), request.content().size());
    }

    private CreateBase createBase(BaseCondition base) {
        if ("UNKNOWN".equals(base.state()) && base.revision() == null && base.contentHash() == null) {
            return UnknownCreateBase.INSTANCE;
        }
        if ("DELETED".equals(base.state()) && base.revision() != null && base.revision() >= 1
                && base.contentHash() == null) {
            return new DeletedCreateBase(base.revision());
        }

        throw new IllegalArgumentException("A CREATE base must be UNKNOWN or a revisioned DELETED state");
    }

    private ModifyOperation modifyOperation(
            ContentMutationRequest request,
            ContentHash.HashedContent actualContent) {
        if (request == null || !"MODIFY".equals(request.type()) || request.content() == null
                || request.base() == null || request.base().length != 1
                || !"PRESENT".equals(request.base()[0].state())
                || request.base()[0].revision() == null || request.base()[0].revision() < 1
                || request.base()[0].contentHash() == null
                || !request.base()[0].contentHash().matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Only a MODIFY operation with a PRESENT base is supported");
        }

        SyncPath path = SyncPath.parse(request.path());
        validateCommon(request, path);
        if (request.content().size() != actualContent.size() || !request.content().contentHash().equals(actualContent.value())) {
            throw new IllegalArgumentException("MODIFY content metadata is invalid");
        }

        return new ModifyOperation(
                request.operationId(),
                request.clientId(),
                path,
                new PresentBase(request.base()[0].revision(), request.base()[0].contentHash()),
                request.content().contentHash(),
                request.content().size());
    }

    private void validateCommon(ContentMutationRequest request, SyncPath path) {
        if (!path.value().equals(request.base()[0].path()) || request.operationId() == null || request.clientId() == null
                || request.operationId().isBlank() || request.clientId().isBlank() || request.content().size() < 0
                || request.content().contentHash() == null
                || !request.content().contentHash().matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Content operation metadata is invalid");
        }
    }

    private static OperationResultResponse response(CreateOperationResult result) {
        return new OperationResultResponse(
                result.operationId(), "COMMITTED", result.resultRevision(), result.replayed());
    }

    private static OperationResultResponse response(OperationResult result) {
        return new OperationResultResponse(
                result.operationId(), "COMMITTED", result.resultRevision(), result.replayed());
    }

    private Response error(int status, String code, String message) {
        return Response.status(status).entity(new ProtocolErrorResponse(new ErrorResponse(code, message))).build();
    }

    @RegisterForReflection
    public record ContentMutationRequest(String operationId, String clientId, String type, String path,
                                BaseCondition[] base, Content content) {
    }

    @RegisterForReflection
    public record BaseCondition(String path, String state, Long revision, String contentHash) {
    }

    @RegisterForReflection
    public record Content(String contentHash, long size) {
    }

    @RegisterForReflection
    public record OperationResultResponse(String operationId, String status, long resultRevision, boolean replayed) {
    }

}
