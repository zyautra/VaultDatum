package io.vaultdatum.server.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.quarkus.runtime.annotations.RegisterForReflection;
import io.vaultdatum.server.sync.PathStateReader;
import io.vaultdatum.server.sync.SyncPath;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/api/v1/path-state")
@Produces(MediaType.APPLICATION_JSON)
public final class PathStateResource {

    private final PathStateReader pathStateReader;

    public PathStateResource(PathStateReader pathStateReader) {
        this.pathStateReader = pathStateReader;
    }

    @GET
    public Response state(@QueryParam("path") String requestedPath) {
        try {
            PathStateReader.PathState state = pathStateReader.read(SyncPath.parse(requestedPath));
            return Response.ok(new PathStateResponse(
                    state.path(),
                    state.entryType(),
                    state.state(),
                    state.revision(),
                    state.contentHash(),
                    state.size())).build();
        } catch (IllegalArgumentException exception) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(new ProtocolErrorResponse(new ErrorResponse("INVALID_REQUEST", exception.getMessage())))
                    .build();
        }
    }

    @RegisterForReflection
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PathStateResponse(
            String path,
            String entryType,
            String state,
            Long revision,
            String contentHash,
            Long size) {
    }
}
