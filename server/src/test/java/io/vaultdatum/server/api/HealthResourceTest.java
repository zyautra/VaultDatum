package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

@QuarkusTest
class HealthResourceTest {

    @Test
    void reportsHealthy() {
        given()
                .when().get("/health")
                .then()
                .statusCode(200)
                .body("status", is("ok"));
    }
}
