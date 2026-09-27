package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.startsWith;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.quarkus.test.common.http.TestHTTPResource;
import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

@QuarkusTest
@TestProfile(PublicTokenTestProfile.class)
class PublicAccessResourceTest {

    @TestHTTPResource("/api/v1/notifications")
    URI notificationsUri;

    @Test
    void protectsSyncApiButNotHealth() {
        given()
                .when().get("/health")
                .then()
                .statusCode(200)
                .body("status", is("ok"));

        given()
                .when().get("/api/v1/vault")
                .then()
                .statusCode(401)
                .header("WWW-Authenticate", is(AccessAuthenticator.BEARER_CHALLENGE))
                .body("error.code", is("UNAUTHORIZED"));

        given()
                .header(AccessAuthenticator.AUTHORIZATION_HEADER, "Bearer vd1_" + "B".repeat(43))
                .when().get("/api/v1/vault")
                .then()
                .statusCode(401)
                .body("error.code", is("UNAUTHORIZED"));

        given()
                .when().post("/api/v1/realtime-tickets")
                .then()
                .statusCode(401)
                .header("WWW-Authenticate", is(AccessAuthenticator.BEARER_CHALLENGE));

        given()
                .header(AccessAuthenticator.AUTHORIZATION_HEADER, bearerToken())
                .when().get("/api/v1/vault")
                .then()
                .statusCode(200)
                .body("vaultId", startsWith("V-"));
    }

    @Test
    void consumesRealtimeTicketOnceAndSelectsOnlyTheProtocolVersion() throws Exception {
        String ticket = given()
                .header(AccessAuthenticator.AUTHORIZATION_HEADER, bearerToken())
                .when().post("/api/v1/realtime-tickets")
                .then()
                .statusCode(201)
                .extract()
                .path("ticket");
        assertEquals(22, ticket.length());

        WebSocket socket = HttpClient.newHttpClient()
                .newWebSocketBuilder()
                .subprotocols(AccessAuthenticator.NOTIFICATION_PROTOCOL, "vaultdatum.ticket." + ticket)
                .buildAsync(webSocketUri(notificationsUri), new WebSocket.Listener() {
                })
                .get(5, TimeUnit.SECONDS);
        assertEquals(AccessAuthenticator.NOTIFICATION_PROTOCOL, socket.getSubprotocol());
        socket.abort();

        assertThrows(ExecutionException.class, () -> HttpClient.newHttpClient()
                .newWebSocketBuilder()
                .subprotocols(AccessAuthenticator.NOTIFICATION_PROTOCOL, "vaultdatum.ticket." + ticket)
                .buildAsync(webSocketUri(notificationsUri), new WebSocket.Listener() {
                })
                .get(5, TimeUnit.SECONDS));
    }

    private static String bearerToken() {
        return "Bearer " + PublicTokenTestProfile.VAULT_TOKEN;
    }

    private static URI webSocketUri(URI uri) {
        return URI.create(uri.toString().replaceFirst("^http", "ws"));
    }
}
