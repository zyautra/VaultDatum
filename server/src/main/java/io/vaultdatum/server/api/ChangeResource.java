package io.vaultdatum.server.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.quarkus.runtime.annotations.RegisterForReflection;
import io.vaultdatum.server.sync.ChangeReader;
import jakarta.ws.rs.DefaultValue;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.util.List;

@Path("/api/v1/changes")
@Produces(MediaType.APPLICATION_JSON)
public final class ChangeResource {

    private final ChangeReader changeReader;

    public ChangeResource(ChangeReader changeReader) {
        this.changeReader = changeReader;
    }

    @GET
    public Response changes(
            @QueryParam("after") Long afterRevision,
            @QueryParam("limit") @DefaultValue("500") int limit) {
        if (afterRevision == null) {
            return error("The after cursor is required");
        }

        try {
            ChangeReader.ChangePage page = changeReader.read(afterRevision, limit);
            return Response.ok(new ChangePageResponse(
                    page.vaultId(),
                    page.fromExclusive(),
                    page.toInclusive(),
                    page.currentRevision(),
                    page.hasMore(),
                    page.changes().stream().map(ChangeResource::response).toList())).build();
        } catch (IllegalArgumentException exception) {
            return error(exception.getMessage());
        }
    }

    private static ChangeResponse response(ChangeReader.Change change) {
        return new ChangeResponse(
                change.revision(),
                change.type(),
                change.operationId(),
                new ActorResponse(change.actor().type(), change.actor().clientId()),
                change.sourcePath(),
                change.destinationPath(),
                change.effects().stream().map(ChangeResource::response).toList());
    }

    private static EffectResponse response(ChangeReader.ChangeEffect effect) {
        return new EffectResponse(
                effect.path(), effect.entryType(), effect.state(), effect.contentHash(), effect.size());
    }

    private static Response error(String message) {
        return Response.status(Response.Status.BAD_REQUEST)
                .entity(new ProtocolErrorResponse(new ErrorResponse("INVALID_REQUEST", message)))
                .build();
    }

    @RegisterForReflection
    public record ChangePageResponse(
            String vaultId,
            long fromExclusive,
            long toInclusive,
            long currentRevision,
            boolean hasMore,
            List<ChangeResponse> changes) {
    }

    @RegisterForReflection
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ChangeResponse(
            long revision,
            String type,
            String operationId,
            ActorResponse actor,
            String sourcePath,
            String destinationPath,
            List<EffectResponse> effects) {
    }

    @RegisterForReflection
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ActorResponse(String type, String clientId) {
    }

    @RegisterForReflection
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EffectResponse(String path, String entryType, String state, String contentHash, Long size) {
    }
}
