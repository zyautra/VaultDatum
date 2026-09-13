package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.startsWith;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

@QuarkusTest
class VaultResourceTest {

    @Test
    void reportsInitializedVaultMetadata() {
        given()
                .when().get("/api/v1/vault")
                .then()
                .statusCode(200)
                .body("vaultId", startsWith("V-"))
                .body("currentRevision", greaterThanOrEqualTo(0))
                .body("oldestRetainedRevision", greaterThanOrEqualTo(0))
                .body("protocolVersion", is(1))
                .body("hashAlgorithm", is("SHA-256"));
    }
}
