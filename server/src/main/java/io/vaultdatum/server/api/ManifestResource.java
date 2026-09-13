package io.vaultdatum.server.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.quarkus.runtime.annotations.RegisterForReflection;
import io.vaultdatum.server.sync.ManifestCoordinator;
import io.vaultdatum.server.sync.ManifestExpiredException;
import io.vaultdatum.server.sync.ManifestNotFoundException;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.util.List;

@Path("/api/v1/manifests")
@Produces(MediaType.APPLICATION_JSON)
public final class ManifestResource {

    private final ManifestCoordinator manifestCoordinator;

    public ManifestResource(ManifestCoordinator manifestCoordinator) {
        this.manifestCoordinator = manifestCoordinator;
    }

    @POST
    public Response create() {
        ManifestCoordinator.Created manifest = manifestCoordinator.create();
        return Response.status(Response.Status.CREATED)
                .entity(new ManifestCreatedResponse(
                        manifest.manifestId(),
                        manifest.vaultId(),
                        manifest.snapshotRevision(),
                        manifest.expiresAt()))
                .build();
    }

    @GET
    @Path("/{manifestId}")
    public Response read(@PathParam("manifestId") String manifestId) {
        try {
            ManifestCoordinator.Snapshot manifest = manifestCoordinator.read(manifestId);
            return Response.ok(new ManifestResponse(
                    manifest.manifestId(),
                    manifest.vaultId(),
                    manifest.snapshotRevision(),
                    manifest.expiresAt(),
                    manifest.entries().stream().map(ManifestResource::response).toList())).build();
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", exception.getMessage());
        } catch (ManifestNotFoundException exception) {
            return error(Response.Status.NOT_FOUND, "MANIFEST_NOT_FOUND", exception.getMessage());
        } catch (ManifestExpiredException exception) {
            return error(Response.Status.CONFLICT, "MANIFEST_EXPIRED", exception.getMessage());
        }
    }

    private static ManifestEntryResponse response(ManifestCoordinator.Entry entry) {
        return new ManifestEntryResponse(
                entry.path(),
                entry.entryType(),
                entry.state(),
                entry.revision(),
                entry.contentHash(),
                entry.size());
    }

    private static Response error(Response.Status status, String code, String message) {
        return Response.status(status)
                .entity(new ProtocolErrorResponse(new ErrorResponse(code, message)))
                .build();
    }

    @RegisterForReflection
    public record ManifestCreatedResponse(
            String manifestId,
            String vaultId,
            long snapshotRevision,
            String expiresAt) {
    }

    @RegisterForReflection
    public record ManifestResponse(
            String manifestId,
            String vaultId,
            long snapshotRevision,
            String expiresAt,
            List<ManifestEntryResponse> entries) {
    }

    @RegisterForReflection
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ManifestEntryResponse(
            String path,
            String entryType,
            String state,
            long revision,
            String contentHash,
            Long size) {
    }
}
