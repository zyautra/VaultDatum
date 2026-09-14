package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.is;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.quarkus.test.junit.QuarkusTest;
import io.vaultdatum.server.config.DataDirectories;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

@QuarkusTest
class DirectoryOperationResourceTest {

    @Inject
    DataDirectories dataDirectories;

    @Test
    void createsMovesAndDeletesAnEmptyDirectoryWithIdempotentRetries() throws IOException {
        String sourcePath = "directories/" + UUID.randomUUID();
        String destinationPath = "archive/" + UUID.randomUUID();
        String create = directoryCreateRequest("OP-" + UUID.randomUUID(), sourcePath);
        int createRevision = given()
                .contentType("application/json")
                .body(create)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("replayed", is(false))
                .extract()
                .path("resultRevision");

        assertTrue(Files.isDirectory(dataDirectories.vault().resolve(sourcePath)));

        given()
                .contentType("application/json")
                .body(create)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("resultRevision", is(createRevision))
                .body("replayed", is(true));

        String move = directoryPathChangeRequest(
                "OP-" + UUID.randomUUID(), "MOVE", sourcePath, destinationPath, createRevision);
        int moveRevision = given()
                .contentType("application/json")
                .body(move)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("replayed", is(false))
                .body("resultRevision", greaterThan(createRevision))
                .extract()
                .path("resultRevision");

        assertFalse(Files.exists(dataDirectories.vault().resolve(sourcePath)));
        assertTrue(Files.isDirectory(dataDirectories.vault().resolve(destinationPath)));

        given()
                .queryParam("after", createRevision)
                .when().get("/api/v1/changes")
                .then()
                .statusCode(200)
                .body("changes[0].type", is("MOVE"))
                .body("changes[0].effects[0].entryType", is("DIRECTORY"))
                .body("changes[0].effects[0].state", is("DELETED"))
                .body("changes[0].effects[1].entryType", is("DIRECTORY"))
                .body("changes[0].effects[1].state", is("PRESENT"));

        String delete = directoryDeleteRequest("OP-" + UUID.randomUUID(), destinationPath, moveRevision);
        int deleteRevision = given()
                .contentType("application/json")
                .body(delete)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("replayed", is(false))
                .extract()
                .path("resultRevision");

        assertFalse(Files.exists(dataDirectories.vault().resolve(destinationPath)));

        given()
                .contentType("application/json")
                .body(delete)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("resultRevision", is(deleteRevision))
                .body("replayed", is(true));
    }

    @Test
    void rejectsDeletionOfANonEmptyDirectoryWithoutPreparingAnOperation() throws IOException {
        String directoryPath = "directories/non-empty-" + UUID.randomUUID();
        int directoryRevision = given()
                .contentType("application/json")
                .body(directoryCreateRequest("OP-" + UUID.randomUUID(), directoryPath))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        Files.writeString(
                dataDirectories.vault().resolve(directoryPath).resolve("child.md"),
                "A file outside synchronized state",
                StandardCharsets.UTF_8);

        String operationId = "OP-" + UUID.randomUUID();
        String request = directoryDeleteRequest(operationId, directoryPath, directoryRevision);
        given()
                .contentType("application/json")
                .body(request)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(409)
                .body("error.code", is("BASE_STATE_MISMATCH"));

        Files.delete(dataDirectories.vault().resolve(directoryPath).resolve("child.md"));
        given()
                .contentType("application/json")
                .body(request)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("replayed", is(false));
    }

    private static String directoryCreateRequest(String operationId, String path) {
        return """
                {"operationId":"%s","clientId":"directory-client","type":"CREATE","entryType":"DIRECTORY","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}]}
                """.formatted(operationId, path, path);
    }

    private static String directoryDeleteRequest(String operationId, String path, int revision) {
        return """
                {"operationId":"%s","clientId":"directory-client","type":"DELETE","entryType":"DIRECTORY","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d}]}
                """.formatted(operationId, path, path, revision);
    }

    private static String directoryPathChangeRequest(
            String operationId,
            String type,
            String sourcePath,
            String destinationPath,
            int revision) {
        return """
                {"operationId":"%s","clientId":"directory-client","type":"%s","entryType":"DIRECTORY","sourcePath":"%s","destinationPath":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d},{"path":"%s","state":"UNKNOWN"}]}
                """.formatted(operationId, type, sourcePath, destinationPath, sourcePath, revision, destinationPath);
    }
}
