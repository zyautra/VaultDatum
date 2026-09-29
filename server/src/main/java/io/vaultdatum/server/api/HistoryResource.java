package io.vaultdatum.server.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.quarkus.runtime.annotations.RegisterForReflection;
import io.vaultdatum.server.sync.ContentNotRetainedException;
import io.vaultdatum.server.sync.HistoryReader;
import io.vaultdatum.server.sync.SyncPath;
import jakarta.ws.rs.DefaultValue;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.StreamingOutput;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;

@Path("/api/v1/history")
public final class HistoryResource {

    private final HistoryReader historyReader;

    public HistoryResource(HistoryReader historyReader) {
        this.historyReader = historyReader;
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response history(
            @QueryParam("path") String requestedPath,
            @QueryParam("before") Long beforeRevision,
            @QueryParam("limit") @DefaultValue("50") int limit) {
        try {
            HistoryReader.HistoryPage page = historyReader.read(SyncPath.parse(requestedPath), beforeRevision, limit);
            return Response.ok(new HistoryPageResponse(
                    page.path(),
                    page.entries().stream().map(HistoryResource::response).toList(),
                    page.hasMore())).build();
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", exception.getMessage());
        }
    }

    @GET
    @Path("/content")
    @Produces(MediaType.APPLICATION_OCTET_STREAM)
    public Response content(@QueryParam("contentHash") String contentHash) {
        try {
            HistoryReader.Content content = historyReader.readContent(contentHash);
            long size = Files.size(content.path());
            StreamingOutput output = stream -> {
                try {
                    Files.copy(content.path(), stream);
                } catch (IOException exception) {
                    throw new IllegalStateException("Could not stream history content", exception);
                }
            };
            return Response.ok(output, MediaType.APPLICATION_OCTET_STREAM)
                    .header("X-VaultDatum-Content-Hash", contentHash)
                    .header("Content-Length", size)
                    .build();
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", exception.getMessage());
        } catch (ContentNotRetainedException exception) {
            return error(Response.Status.NOT_FOUND, "CONTENT_NOT_RETAINED", exception.getMessage());
        } catch (IOException exception) {
            return error(Response.Status.NOT_FOUND, "CONTENT_NOT_RETAINED", "The content is no longer kept");
        }
    }

    private static HistoryEntryResponse response(HistoryReader.HistoryEntry entry) {
        return new HistoryEntryResponse(
                entry.revision(),
                entry.type(),
                entry.committedAt(),
                new ChangeResource.ActorResponse(entry.actor().type(), entry.actor().clientId()),
                entry.state(),
                entry.contentHash(),
                entry.size(),
                entry.contentAvailable(),
                entry.previousPath());
    }

    private static Response error(Response.Status status, String code, String message) {
        return Response.status(status)
                .type(MediaType.APPLICATION_JSON)
                .entity(new ProtocolErrorResponse(new ErrorResponse(code, message)))
                .build();
    }

    @RegisterForReflection
    public record HistoryPageResponse(String path, List<HistoryEntryResponse> entries, boolean hasMore) {
    }

    @RegisterForReflection
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record HistoryEntryResponse(
            long revision,
            String type,
            String committedAt,
            ChangeResource.ActorResponse actor,
            String state,
            String contentHash,
            Long size,
            boolean contentAvailable,
            String previousPath) {
    }
}
