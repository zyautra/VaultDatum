package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.is;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertEquals;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.restassured.response.Response;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHash;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

@QuarkusTest
class ModifyAndDeleteOperationResourceTest {

    @Inject
    DataDirectories dataDirectories;

    @Test
    void modifiesAndDeletesAFileWithPresentBaseConditions() throws IOException {
        String path = "mutations/" + UUID.randomUUID() + ".md";
        byte[] initial = "Initial content".getBytes(StandardCharsets.UTF_8);
        String initialHash = ContentHash.calculate(initial);
        int createdRevision = postContent(createRequest("OP-" + UUID.randomUUID(), path, initial), initial)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        byte[] modified = "Modified content".getBytes(StandardCharsets.UTF_8);
        String modifiedHash = ContentHash.calculate(modified);
        String modifyOperationId = "OP-" + UUID.randomUUID();
        int modifiedRevision = postContent(
                modifyRequest(modifyOperationId, path, createdRevision, initialHash, modified),
                modified)
                .then()
                .statusCode(200)
                .body("resultRevision", greaterThan(createdRevision))
                .body("replayed", is(false))
                .extract()
                .path("resultRevision");

        assertEquals("Modified content", Files.readString(dataDirectories.vault().resolve(path)));

        postContent(
                modifyRequest("OP-" + UUID.randomUUID(), path, createdRevision, initialHash, initial),
                initial)
                .then()
                .statusCode(409)
                .body("error.code", is("BASE_STATE_MISMATCH"));

        String deleteOperationId = "OP-" + UUID.randomUUID();
        String deleteRequest = deleteRequest(deleteOperationId, path, modifiedRevision, modifiedHash);
        int deletedRevision = given()
                .contentType("application/json")
                .body(deleteRequest)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("resultRevision", greaterThan(modifiedRevision))
                .body("replayed", is(false))
                .extract()
                .path("resultRevision");

        assertFalse(Files.exists(dataDirectories.vault().resolve(path)));

        given()
                .contentType("application/json")
                .body(deleteRequest)
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .body("resultRevision", is(deletedRevision))
                .body("replayed", is(true));

        given()
                .queryParam("after", modifiedRevision)
                .when().get("/api/v1/changes")
                .then()
                .statusCode(200)
                .body("changes[0].type", is("DELETE"))
                .body("changes[0].effects[0].state", is("DELETED"));
    }

    private static Response postContent(String metadata, byte[] content) {
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
                {"operationId":"%s","clientId":"mutation-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }

    private static String modifyRequest(
            String operationId,
            String path,
            int revision,
            String baseHash,
            byte[] content) {
        return """
                {"operationId":"%s","clientId":"mutation-client","type":"MODIFY","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(
                operationId,
                path,
                path,
                revision,
                baseHash,
                ContentHash.calculate(content),
                content.length);
    }

    private static String deleteRequest(String operationId, String path, int revision, String baseHash) {
        return """
                {"operationId":"%s","clientId":"mutation-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                """.formatted(operationId, path, path, revision, baseHash);
    }
}
