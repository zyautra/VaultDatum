package io.vaultdatum.server.api;

import io.quarkus.websockets.next.OnOpen;
import io.quarkus.websockets.next.WebSocket;

@WebSocket(path = "/api/v1/notifications", endpointId = NotificationEndpoint.ID)
public final class NotificationEndpoint {

    public static final String ID = "vaultdatum-notifications";

    @OnOpen
    public void open() {
        // Notifications are advisory. A client always reads authoritative state through HTTP.
    }
}
