package io.vaultdatum.server.sync;

import io.quarkus.websockets.next.OpenConnections;
import io.vaultdatum.server.api.NotificationEndpoint;
import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped
public final class RevisionNotificationPublisher {

    private final OpenConnections connections;

    public RevisionNotificationPublisher(OpenConnections connections) {
        this.connections = connections;
    }

    public void publish(long currentRevision) {
        String message = "{\"type\":\"REVISION_ADVANCED\",\"currentRevision\":" + currentRevision + "}";
        for (var connection : connections.findByEndpointId(NotificationEndpoint.ID)) {
            connection.sendText(message).subscribe().with(ignored -> {
                // A failed advisory delivery never affects the committed mutation.
            }, ignored -> {
                // Disconnected clients catch up from the change journal or a manifest.
            });
        }
    }
}
