package io.vaultdatum.server.api;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHash;
import io.vaultdatum.server.sync.CreateConflictException;
import io.vaultdatum.server.sync.CreateCoordinator;
import io.vaultdatum.server.sync.CreateOperation;
import io.vaultdatum.server.sync.CreateOperationResult;
import io.vaultdatum.server.sync.OperationIdReuseException;
import io.vaultdatum.server.sync.RecoveryRequiredException;
import io.vaultdatum.server.sync.SyncPath;
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

    public OperationResource(
            ObjectMapper objectMapper,
            DataDirectories dataDirectories,
            CreateCoordinator createCoordinator) {
        this.objectMapper = objectMapper;
        this.dataDirectories = dataDirectories;
        this.createCoordinator = createCoordinator;
    }

    @POST
    public Response submitCreate(
            @RestForm("operation") String serializedOperation,
            @RestForm("content") FileUpload uploadedContent) {
        CreateOperation operation;

        try {
            operation = validate(parse(serializedOperation));
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST.getStatusCode(), "INVALID_REQUEST", exception.getMessage());
        }
        if (uploadedContent == null) {
            return error(Response.Status.BAD_REQUEST.getStatusCode(), "INVALID_REQUEST", "Content is required for CREATE.");
        }

        java.nio.file.Path stagedContent = null;
        try {
            stagedContent = Files.createTempFile(dataDirectories.staging(), "upload-", ".tmp");
            ContentHash.HashedContent actualContent = ContentHash.copy(uploadedContent.uploadedFile(), stagedContent);

            if (!actualContent.value().equals(operation.contentHash()) || actualContent.size() != operation.size()) {
                Files.deleteIfExists(stagedContent);
                return error(422, "CONTENT_HASH_MISMATCH",
                        "Uploaded content does not match the declared hash and size.");
            }

            CreateOperationResult result = createCoordinator.commit(operation, stagedContent);
            return Response.ok(new OperationResultResponse(
                    result.operationId(), "COMMITTED", result.resultRevision(), result.replayed())).build();
        } catch (CreateConflictException exception) {
            deleteIfPresent(stagedContent);
            return error(Response.Status.CONFLICT.getStatusCode(), "BASE_STATE_MISMATCH", exception.getMessage());
        } catch (OperationIdReuseException exception) {
            deleteIfPresent(stagedContent);
            return error(Response.Status.CONFLICT.getStatusCode(), "OPERATION_ID_REUSED", exception.getMessage());
        } catch (RecoveryRequiredException exception) {
            return error(Response.Status.SERVICE_UNAVAILABLE.getStatusCode(), "RECOVERY_REQUIRED", exception.getMessage());
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

    private CreateRequest parse(String serializedOperation) {
        try {
            return objectMapper.readValue(serializedOperation, CreateRequest.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Operation metadata must be valid JSON", exception);
        }
    }

    private CreateOperation validate(CreateRequest request) {
        if (request == null || !"CREATE".equals(request.type()) || request.content() == null
                || request.base() == null || request.base().length != 1
                || !"UNKNOWN".equals(request.base()[0].state())) {
            throw new IllegalArgumentException("Only a CREATE operation with an UNKNOWN base is supported");
        }

        SyncPath path = SyncPath.parse(request.path());
        if (!path.value().equals(request.base()[0].path()) || request.operationId() == null || request.clientId() == null
                || request.operationId().isBlank() || request.clientId().isBlank() || request.content().size() < 0
                || request.content().contentHash() == null
                || !request.content().contentHash().matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalArgumentException("CREATE metadata is invalid");
        }

        return new CreateOperation(
                request.operationId(), request.clientId(), path, request.content().contentHash(), request.content().size());
    }

    private Response error(int status, String code, String message) {
        return Response.status(status).entity(new ProtocolErrorResponse(new ErrorResponse(code, message))).build();
    }

    @RegisterForReflection
    public record CreateRequest(String operationId, String clientId, String type, String path,
                                BaseCondition[] base, Content content) {
    }

    @RegisterForReflection
    public record BaseCondition(String path, String state) {
    }

    @RegisterForReflection
    public record Content(String contentHash, long size) {
    }

    @RegisterForReflection
    public record OperationResultResponse(String operationId, String status, long resultRevision, boolean replayed) {
    }

}
