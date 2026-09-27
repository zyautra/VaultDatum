package io.vaultdatum.server.api;

import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/api/v1/realtime-tickets")
@Produces(MediaType.APPLICATION_JSON)
public final class RealtimeTicketResource {

    private final AccessAuthenticator accessAuthenticator;

    public RealtimeTicketResource(AccessAuthenticator accessAuthenticator) {
        this.accessAuthenticator = accessAuthenticator;
    }

    @POST
    public Response create() {
        if (!accessAuthenticator.requiresVaultToken()) {
            return Response.status(Response.Status.NOT_FOUND).build();
        }
        return Response.status(Response.Status.CREATED)
                .entity(accessAuthenticator.issueRealtimeTicket())
                .build();
    }
}
