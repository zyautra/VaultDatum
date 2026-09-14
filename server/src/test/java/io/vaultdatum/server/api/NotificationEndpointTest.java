package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.quarkus.test.common.http.TestHTTPResource;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.vaultdatum.server.sync.ContentHash;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

@QuarkusTest
class NotificationEndpointTest {

    @TestHTTPResource("/api/v1/notifications")
    URI notificationsUri;

    @Test
    void sendsOneRevisionHintForANewCommitButNotItsReplay() throws Exception {
        NotificationListener listener = new NotificationListener();
        WebSocket socket = HttpClient.newHttpClient()
                .newWebSocketBuilder()
                .buildAsync(webSocketUri(notificationsUri), listener)
                .get(5, TimeUnit.SECONDS);

        String operationId = "OP-" + UUID.randomUUID();
        String path = "notifications/" + UUID.randomUUID() + ".md";
        byte[] content = "Notification content".getBytes(StandardCharsets.UTF_8);
        String metadata = createRequest(operationId, path, content);

        int revision = post(metadata, content)
                .then()
                .statusCode(200)
                .body("replayed", org.hamcrest.Matchers.is(false))
                .extract()
                .path("resultRevision");

        assertEquals(
                "{\"type\":\"REVISION_ADVANCED\",\"currentRevision\":" + revision + "}",
                listener.messages.poll(5, TimeUnit.SECONDS));

        post(metadata, content)
                .then()
                .statusCode(200)
                .body("replayed", org.hamcrest.Matchers.is(true));
        assertNull(listener.messages.poll(300, TimeUnit.MILLISECONDS));

        socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS);
    }

    private static URI webSocketUri(URI uri) {
        return URI.create(uri.toString().replaceFirst("^http", "ws"));
    }

    private static io.restassured.response.Response post(String metadata, byte[] content) {
        return given()
                .multiPart(new MultiPartSpecBuilder(metadata)
                        .controlName("operation")
                        .mimeType("application/json")
                        .build())
                .multiPart("content", "content.bin", content, "application/octet-stream")
                .when().post("/api/v1/operations");
    }

    private static String createRequest(String operationId, String path, byte[] content) {
        return """
                {"operationId":"%s","clientId":"notification-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }

    private static final class NotificationListener implements WebSocket.Listener {

        private final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();

        private final StringBuilder partialMessage = new StringBuilder();

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            partialMessage.append(data);
            if (last) {
                messages.add(partialMessage.toString());
                partialMessage.setLength(0);
            }
            webSocket.request(1);
            return CompletableFuture.completedFuture(null);
        }
    }
}
