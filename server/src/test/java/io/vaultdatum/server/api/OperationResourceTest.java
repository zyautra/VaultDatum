package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.is;

import io.vaultdatum.server.config.ContentLimits;
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
import java.util.Random;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

@QuarkusTest
class OperationResourceTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    ContentLimits contentLimits;

    @Test
    void commitsCreatePersistsContentAndReplaysTheSameOperation() throws IOException {
        long initialStagingFiles = stagingFileCount();
        String operationId = "OP-" + UUID.randomUUID();
        String path = "notes/" + UUID.randomUUID() + ".md";
        byte[] content = "First server note".getBytes(StandardCharsets.UTF_8);
        String metadata = createRequest(operationId, path, content);

        int revision = post(metadata, content)
                .then()
                .statusCode(200)
                .body("operationId", is(operationId))
                .body("status", is("COMMITTED"))
                .body("resultRevision", greaterThan(0))
                .body("replayed", is(false))
                .extract()
                .path("resultRevision");

        assertEquals("First server note", Files.readString(dataDirectories.vault().resolve(path)));

        post(metadata, content)
                .then()
                .statusCode(200)
                .body("operationId", is(operationId))
                .body("resultRevision", is(revision))
                .body("replayed", is(true));
        assertEquals(initialStagingFiles, stagingFileCount());

        given()
                .when().get("/api/v1/vault")
                .then()
                .statusCode(200)
                .body("currentRevision", is(revision));
    }

    @Test
    void rejectsConflictingOrInvalidCreateWithoutWritingAFile() throws IOException {
        String operationId = "OP-" + UUID.randomUUID();
        String path = "notes/" + UUID.randomUUID() + ".md";
        byte[] content = "Original content".getBytes(StandardCharsets.UTF_8);
        String metadata = createRequest(operationId, path, content);

        post(metadata, content).then().statusCode(200);

        post(createRequest("OP-" + UUID.randomUUID(), path, "Conflicting content".getBytes(StandardCharsets.UTF_8)),
                "Conflicting content".getBytes(StandardCharsets.UTF_8))
                .then()
                .statusCode(409)
                .body("error.code", is("BASE_STATE_MISMATCH"));
        assertEquals("Original content", Files.readString(dataDirectories.vault().resolve(path)));

        byte[] mismatchedContent = "The declared hash is wrong".getBytes(StandardCharsets.UTF_8);
        String mismatchedPath = "notes/" + UUID.randomUUID() + ".md";
        String mismatchedMetadata = createRequest(
                "OP-" + UUID.randomUUID(), mismatchedPath, "Different bytes".getBytes(StandardCharsets.UTF_8));

        post(mismatchedMetadata, mismatchedContent)
                .then()
                .statusCode(422)
                .body("error.code", is("CONTENT_HASH_MISMATCH"));
        assertFalse(Files.exists(dataDirectories.vault().resolve(mismatchedPath)));

        given()
                .multiPart(new MultiPartSpecBuilder(createRequest(
                                "OP-" + UUID.randomUUID(), "../outside.md", content))
                        .controlName("operation")
                        .mimeType("application/json")
                        .build())
                .multiPart("content", "outside.md", content, "application/octet-stream")
                .when().post("/api/v1/operations")
                .then()
                .statusCode(400)
                .body("error.code", is("INVALID_REQUEST"));
    }

    @Test
    void rejectsReusingAnOperationIdForDifferentRequest() {
        String operationId = "OP-" + UUID.randomUUID();
        byte[] firstContent = "Original request".getBytes(StandardCharsets.UTF_8);
        String firstPath = "notes/" + UUID.randomUUID() + ".md";

        post(createRequest(operationId, firstPath, firstContent), firstContent).then().statusCode(200);

        byte[] secondContent = "Different request".getBytes(StandardCharsets.UTF_8);
        String secondPath = "notes/" + UUID.randomUUID() + ".md";

        post(createRequest(operationId, secondPath, secondContent), secondContent)
                .then()
                .statusCode(409)
                .body("error.code", is("OPERATION_ID_REUSED"));
        assertFalse(Files.exists(dataDirectories.vault().resolve(secondPath)));
    }

    @Test
    void storesAndReturnsBinaryAttachmentBytesWithoutTextEncoding() throws IOException {
        String operationId = "OP-" + UUID.randomUUID();
        String path = "attachments/" + UUID.randomUUID() + ".png";
        byte[] content = new byte[512 * 1024];
        new Random(42).nextBytes(content);

        int revision = post(createRequest(operationId, path, content), content)
                .then()
                .statusCode(200)
                .body("replayed", is(false))
                .extract()
                .path("resultRevision");

        byte[] downloaded = given()
                .queryParam("path", path)
                .queryParam("revision", revision)
                .queryParam("hash", ContentHash.calculate(content))
                .when()
                .get("/api/v1/content")
                .then()
                .statusCode(200)
                .header("x-vaultdatum-content-hash", ContentHash.calculate(content))
                .extract()
                .asByteArray();

        assertArrayEquals(content, downloaded);
        assertArrayEquals(content, Files.readAllBytes(dataDirectories.vault().resolve(path)));
    }

    @Test
    void rejectsContentOverTheConfiguredAttachmentLimit() throws IOException {
        byte[] content = new byte[Math.toIntExact(contentLimits.maximumContentBytes() + 1)];
        String path = "attachments/" + UUID.randomUUID() + ".bin";

        post(createRequest("OP-" + UUID.randomUUID(), path, content), content)
                .then()
                .statusCode(413)
                .body("error.code", is("CONTENT_TOO_LARGE"));

        assertFalse(Files.exists(dataDirectories.vault().resolve(path)));
    }

    private static Response post(String metadata, byte[] content) {
        return given()
                .multiPart(new MultiPartSpecBuilder(metadata)
                        .controlName("operation")
                        .mimeType("application/json")
                        .build())
                .multiPart("content", "content.bin", content, "application/octet-stream")
                .when().post("/api/v1/operations");
    }

    private long stagingFileCount() throws IOException {
        try (var files = Files.list(dataDirectories.staging())) {
            return files.count();
        }
    }

    private static String createRequest(String operationId, String path, byte[] content) {
        return """
                {"operationId":"%s","clientId":"client-a","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }
}
