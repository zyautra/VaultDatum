package io.vaultdatum.server.api;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.quarkus.runtime.annotations.RegisterForReflection;
import io.vaultdatum.server.sync.BaseStateMismatchException;
import io.vaultdatum.server.sync.DeleteCoordinator;
import io.vaultdatum.server.sync.DeleteOperation;
import io.vaultdatum.server.sync.DirectoryCoordinator;
import io.vaultdatum.server.sync.DirectoryCreateOperation;
import io.vaultdatum.server.sync.DirectoryDeleteOperation;
import io.vaultdatum.server.sync.DirectoryPathChangeOperation;
import io.vaultdatum.server.sync.OperationIdReuseException;
import io.vaultdatum.server.sync.OperationResult;
import io.vaultdatum.server.sync.PathChangeType;
import io.vaultdatum.server.sync.PresentBase;
import io.vaultdatum.server.sync.RecoveryRequiredException;
import io.vaultdatum.server.sync.PathChangeCoordinator;
import io.vaultdatum.server.sync.PathChangeOperation;
import io.vaultdatum.server.sync.RevisionNotificationPublisher;
import io.vaultdatum.server.sync.SyncPath;
import io.vaultdatum.server.sync.VaultDriftException;
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

    private final PathChangeCoordinator pathChangeCoordinator;

    private final DirectoryCoordinator directoryCoordinator;

    private final RevisionNotificationPublisher notificationPublisher;

    public DeleteOperationResource(
            ObjectMapper objectMapper,
            DeleteCoordinator deleteCoordinator,
            PathChangeCoordinator pathChangeCoordinator,
            DirectoryCoordinator directoryCoordinator,
            RevisionNotificationPublisher notificationPublisher) {
        this.objectMapper = objectMapper;
        this.deleteCoordinator = deleteCoordinator;
        this.pathChangeCoordinator = pathChangeCoordinator;
        this.directoryCoordinator = directoryCoordinator;
        this.notificationPublisher = notificationPublisher;
    }

    @POST
    public Response submitMetadataMutation(String serializedOperation) {
        try {
            MetadataRequest request = parse(serializedOperation);
            validateEntryType(request);
            OperationResult result = switch (request.type()) {
                case "CREATE" -> directoryCoordinator.create(directoryCreateOperation(request));
                case "DELETE" -> isDirectory(request)
                        ? directoryCoordinator.delete(directoryDeleteOperation(request))
                        : deleteCoordinator.commit(deleteOperation(request));
                case "RENAME" -> isDirectory(request)
                        ? directoryCoordinator.changePath(directoryPathChangeOperation(request, PathChangeType.RENAME))
                        : pathChangeCoordinator.commit(pathChangeOperation(request, PathChangeType.RENAME));
                case "MOVE" -> isDirectory(request)
                        ? directoryCoordinator.changePath(directoryPathChangeOperation(request, PathChangeType.MOVE))
                        : pathChangeCoordinator.commit(pathChangeOperation(request, PathChangeType.MOVE));
                default -> throw new IllegalArgumentException("Only CREATE, DELETE, RENAME, and MOVE metadata operations are supported");
            };
            if (!result.replayed()) {
                notificationPublisher.publish(result.resultRevision());
            }
            return Response.ok(new OperationResource.OperationResultResponse(
                    result.operationId(), "COMMITTED", result.resultRevision(), result.replayed())).build();
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", exception.getMessage());
        } catch (BaseStateMismatchException exception) {
            return error(Response.Status.CONFLICT, "BASE_STATE_MISMATCH", exception.getMessage());
        } catch (OperationIdReuseException exception) {
            return error(Response.Status.CONFLICT, "OPERATION_ID_REUSED", exception.getMessage());
        } catch (VaultDriftException | RecoveryRequiredException exception) {
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

    private DirectoryCreateOperation directoryCreateOperation(MetadataRequest request) {
        if (!isDirectory(request) || request.base() == null || request.base().length != 1
                || !"UNKNOWN".equals(request.base()[0].state())
                || request.base()[0].revision() != null || request.base()[0].contentHash() != null) {
            throw new IllegalArgumentException("A directory CREATE requires an UNKNOWN base");
        }
        SyncPath path = SyncPath.parse(request.path());
        validateCommon(request, path, "Directory CREATE");
        if (!path.value().equals(request.base()[0].path())) {
            throw new IllegalArgumentException("Directory CREATE metadata is invalid");
        }
        return new DirectoryCreateOperation(request.operationId(), request.clientId(), path);
    }

    private DirectoryDeleteOperation directoryDeleteOperation(MetadataRequest request) {
        if (!isDirectory(request) || request.base() == null || request.base().length != 1
                || !"PRESENT".equals(request.base()[0].state())
                || request.base()[0].revision() == null || request.base()[0].revision() < 1
                || request.base()[0].contentHash() != null) {
            throw new IllegalArgumentException("A directory DELETE requires a PRESENT directory base");
        }
        SyncPath path = SyncPath.parse(request.path());
        validateCommon(request, path, "Directory DELETE");
        if (!path.value().equals(request.base()[0].path())) {
            throw new IllegalArgumentException("Directory DELETE metadata is invalid");
        }
        return new DirectoryDeleteOperation(
                request.operationId(), request.clientId(), path, request.base()[0].revision());
    }

    private DirectoryPathChangeOperation directoryPathChangeOperation(MetadataRequest request, PathChangeType type) {
        if (!isDirectory(request) || request.base() == null || request.base().length != 2
                || !"PRESENT".equals(request.base()[0].state())
                || request.base()[0].revision() == null || request.base()[0].revision() < 1
                || request.base()[0].contentHash() != null
                || !"UNKNOWN".equals(request.base()[1].state())
                || request.base()[1].revision() != null || request.base()[1].contentHash() != null) {
            throw new IllegalArgumentException(type + " directory operation requires PRESENT source and UNKNOWN destination bases");
        }
        SyncPath source = SyncPath.parse(request.sourcePath());
        SyncPath destination = SyncPath.parse(request.destinationPath());
        validateCommon(request, source, type + " directory");
        if (source.equals(destination) || !source.value().equals(request.base()[0].path())
                || !destination.value().equals(request.base()[1].path())) {
            throw new IllegalArgumentException(type + " directory metadata is invalid");
        }
        return new DirectoryPathChangeOperation(
                request.operationId(), request.clientId(), type, source, destination, request.base()[0].revision());
    }

    private PathChangeOperation pathChangeOperation(MetadataRequest request, PathChangeType type) {
        if (request.base() == null || request.base().length != 2
                || !"PRESENT".equals(request.base()[0].state())
                || request.base()[0].revision() == null || request.base()[0].revision() < 1
                || request.base()[0].contentHash() == null
                || !request.base()[0].contentHash().matches("sha256:[0-9a-f]{64}")
                || !"UNKNOWN".equals(request.base()[1].state())
                || request.base()[1].revision() != null || request.base()[1].contentHash() != null) {
            throw new IllegalArgumentException(type + " requires PRESENT source and UNKNOWN destination bases");
        }
        SyncPath source = SyncPath.parse(request.sourcePath());
        SyncPath destination = SyncPath.parse(request.destinationPath());
        if (source.equals(destination) || request.operationId() == null || request.clientId() == null
                || request.operationId().isBlank() || request.clientId().isBlank()
                || !source.value().equals(request.base()[0].path())
                || !destination.value().equals(request.base()[1].path())) {
            throw new IllegalArgumentException(type + " metadata is invalid");
        }
        return new PathChangeOperation(
                request.operationId(), request.clientId(), type, source, destination,
                new PresentBase(request.base()[0].revision(), request.base()[0].contentHash()));
    }

    private static boolean isDirectory(MetadataRequest request) {
        return "DIRECTORY".equals(request.entryType());
    }

    private static void validateEntryType(MetadataRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Operation metadata is required");
        }
        if (request.entryType() != null && !"DIRECTORY".equals(request.entryType())) {
            throw new IllegalArgumentException("entryType must be DIRECTORY when supplied");
        }
    }

    private static void validateCommon(MetadataRequest request, SyncPath path, String operation) {
        if (request.operationId() == null || request.clientId() == null || request.operationId().isBlank()
                || request.clientId().isBlank() || path == null) {
            throw new IllegalArgumentException(operation + " metadata is invalid");
        }
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
            String entryType,
            String path,
            String sourcePath,
            String destinationPath,
            OperationResource.BaseCondition[] base) {
    }
}
