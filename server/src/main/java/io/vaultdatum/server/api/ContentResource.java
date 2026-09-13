package io.vaultdatum.server.api;

import io.vaultdatum.server.sync.ContentReader;
import io.vaultdatum.server.sync.StateChangedException;
import io.vaultdatum.server.sync.SyncPath;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.StreamingOutput;

import java.io.IOException;
import java.nio.file.Files;

@Path("/api/v1/content")
public final class ContentResource {

    private final ContentReader contentReader;

    public ContentResource(ContentReader contentReader) {
        this.contentReader = contentReader;
    }

    @GET
    @Produces(MediaType.APPLICATION_OCTET_STREAM)
    public Response content(
            @QueryParam("path") String requestedPath,
            @QueryParam("revision") Long revision,
            @QueryParam("hash") String contentHash) {
        if (revision == null || revision < 1 || contentHash == null
                || !contentHash.matches("sha256:[0-9a-f]{64}")) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", "The content request is invalid");
        }

        try {
            ContentReader.Content content = contentReader.read(SyncPath.parse(requestedPath), revision, contentHash);
            StreamingOutput output = stream -> {
                try {
                    Files.copy(content.path(), stream);
                } catch (IOException exception) {
                    throw new IllegalStateException("Could not stream authoritative content", exception);
                }
            };
            return Response.ok(output, MediaType.APPLICATION_OCTET_STREAM)
                    .header("X-VaultDatum-Content-Hash", contentHash)
                    .header("Content-Length", content.size())
                    .build();
        } catch (IllegalArgumentException exception) {
            return error(Response.Status.BAD_REQUEST, "INVALID_REQUEST", exception.getMessage());
        } catch (StateChangedException exception) {
            return error(Response.Status.CONFLICT, "STATE_CHANGED", exception.getMessage());
        }
    }

    private static Response error(Response.Status status, String code, String message) {
        return Response.status(status)
                .type(MediaType.APPLICATION_JSON)
                .entity(new ProtocolErrorResponse(new ErrorResponse(code, message)))
                .build();
    }
}
