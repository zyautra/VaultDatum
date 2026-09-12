package io.vaultdatum.server.api;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/health")
@Produces(MediaType.APPLICATION_JSON)
public final class HealthResource {

    @GET
    public HealthResponse health() {
        return new HealthResponse("ok");
    }

    public record HealthResponse(String status) {
    }
}
