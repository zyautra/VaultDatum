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

    public DeleteOperationResource(ObjectMapper objectMapper, DeleteCoordinator deleteCoordinator) {
        this.objectMapper = objectMapper;
        this.deleteCoordinator = deleteCoordinator;
    }

    @POST
    public Response submitDelete(String serializedOperation) {
        try {
            DeleteOperation operation = validate(parse(serializedOperation));
            OperationResult result = deleteCoordinator.commit(operation);
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

    private DeleteRequest parse(String serializedOperation) {
        try {
            return objectMapper.readValue(serializedOperation, DeleteRequest.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Operation metadata must be valid JSON", exception);
        }
    }

    private DeleteOperation validate(DeleteRequest request) {
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

    private static Response error(Response.Status status, String code, String message) {
        return Response.status(status)
                .entity(new ProtocolErrorResponse(new ErrorResponse(code, message)))
                .build();
    }

    @RegisterForReflection
    public record DeleteRequest(
            String operationId,
            String clientId,
            String type,
            String path,
            OperationResource.BaseCondition[] base) {
    }
}
