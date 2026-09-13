package io.vaultdatum.server.api;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.quarkus.runtime.annotations.RegisterForReflection;
import io.vaultdatum.server.sync.BaseStateMismatchException;
import io.vaultdatum.server.sync.DeleteCoordinator;
import io.vaultdatum.server.sync.DeleteOperation;
import io.vaultdatum.server.sync.OperationIdReuseException;
import io.vaultdatum.server.sync.OperationResult;
import io.vaultdatum.server.sync.PresentBase;
import io.vaultdatum.server.sync.RecoveryRequiredException;
import io.vaultdatum.server.sync.RenameCoordinator;
import io.vaultdatum.server.sync.RenameOperation;
import io.vaultdatum.server.sync.SyncPath;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/api/v1/operations")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public final class DeleteOperationResource {

    private final ObjectMapper objectMapper;

    private final DeleteCoordinator deleteCoordinator;

    private final RenameCoordinator renameCoordinator;

    public DeleteOperationResource(
            ObjectMapper objectMapper,
            DeleteCoordinator deleteCoordinator,
            RenameCoordinator renameCoordinator) {
        this.objectMapper = objectMapper;
        this.deleteCoordinator = deleteCoordinator;
        this.renameCoordinator = renameCoordinator;
    }

    @POST
    public Response submitMetadataMutation(String serializedOperation) {
        try {
            MetadataRequest request = parse(serializedOperation);
            OperationResult result = switch (request.type()) {
                case "DELETE" -> deleteCoordinator.commit(deleteOperation(request));
                case "RENAME" -> renameCoordinator.commit(renameOperation(request));
                default -> throw new IllegalArgumentException("Only DELETE and RENAME metadata operations are supported");
            };
            return Response.ok(new OperationResource.OperationResultResponse(
                    result.operationId(), "COMMITTED", result.resultRevision(), result.replayed())).build();
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", exception.getMessage());
        } catch (BaseStateMismatchException exception) {
            return error(Response.Status.CONFLICT, "BASE_STATE_MISMATCH", exception.getMessage());
        } catch (OperationIdReuseException exception) {
            return error(Response.Status.CONFLICT, "OPERATION_ID_REUSED", exception.getMessage());
        } catch (RecoveryRequiredException exception) {
            return error(Response.Status.SERVICE_UNAVAILABLE, "RECOVERY_REQUIRED", exception.getMessage());
        }
    }

    private MetadataRequest parse(String serializedOperation) {
        try {
            return objectMapper.readValue(serializedOperation, MetadataRequest.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Operation metadata must be valid JSON", exception);
        }
    }

    private DeleteOperation deleteOperation(MetadataRequest request) {
        if (request == null || !"DELETE".equals(request.type()) || request.base() == null
                || request.base().length != 1 || !"PRESENT".equals(request.base()[0].state())
                || request.base()[0].revision() == null || request.base()[0].revision() < 1
                || request.base()[0].contentHash() == null
                || !request.base()[0].contentHash().matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Only a DELETE operation with a PRESENT base is supported");
        }

        SyncPath path = SyncPath.parse(request.path());
        if (!path.value().equals(request.base()[0].path()) || request.operationId() == null || request.clientId() == null
                || request.operationId().isBlank() || request.clientId().isBlank()) {
            throw new IllegalArgumentException("DELETE metadata is invalid");
        }

        return new DeleteOperation(
                request.operationId(),
                request.clientId(),
                path,
                new PresentBase(request.base()[0].revision(), request.base()[0].contentHash()));
    }

    private RenameOperation renameOperation(MetadataRequest request) {
        if (request.base() == null || request.base().length != 2
                || !"PRESENT".equals(request.base()[0].state())
                || request.base()[0].revision() == null || request.base()[0].revision() < 1
                || request.base()[0].contentHash() == null
                || !request.base()[0].contentHash().matches("sha256:[0-9a-f]{64}")
                || !"UNKNOWN".equals(request.base()[1].state())
                || request.base()[1].revision() != null || request.base()[1].contentHash() != null) {
            throw new IllegalArgumentException("A RENAME requires PRESENT source and UNKNOWN destination bases");
        }
        SyncPath source = SyncPath.parse(request.sourcePath());
        SyncPath destination = SyncPath.parse(request.destinationPath());
        if (source.equals(destination) || request.operationId() == null || request.clientId() == null
                || request.operationId().isBlank() || request.clientId().isBlank()
                || !source.value().equals(request.base()[0].path())
                || !destination.value().equals(request.base()[1].path())) {
            throw new IllegalArgumentException("RENAME metadata is invalid");
        }
        return new RenameOperation(
                request.operationId(), request.clientId(), source, destination,
                new PresentBase(request.base()[0].revision(), request.base()[0].contentHash()));
    }

    private static Response error(Response.Status status, String code, String message) {
        return Response.status(status)
                .entity(new ProtocolErrorResponse(new ErrorResponse(code, message)))
                .build();
    }

    @RegisterForReflection
    public record MetadataRequest(
            String operationId,
            String clientId,
            String type,
            String path,
            String sourcePath,
            String destinationPath,
            OperationResource.BaseCondition[] base) {
    }
}
