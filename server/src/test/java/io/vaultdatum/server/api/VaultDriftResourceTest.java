package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static org.hamcrest.Matchers.is;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.restassured.response.Response;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHash;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

@QuarkusTest
class VaultDriftResourceTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Test
    void rejectsModifyOfDirectlyEditedFileWithoutPreparingIt() throws IOException {
        long initialStagingFiles = stagingFileCount();
        String path = "drift/" + UUID.randomUUID() + ".md";
        int revision = create(path, "Synchronized content");
        Path file = dataDirectories.vault().resolve(path);
        Files.writeString(file, "Edited directly on the server", StandardCharsets.UTF_8);

        byte[] content = "Client edit".getBytes(StandardCharsets.UTF_8);
        String operationId = "OP-" + UUID.randomUUID();
        String request = """
                {"operationId":"%s","clientId":"drift-client","type":"MODIFY","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(
                operationId, path, path, revision, hash("Synchronized content"),
                ContentHash.calculate(content), content.length);

        postContent(request, content)
                .then()
                .statusCode(503)
                .body("error.code", is("RECOVERY_REQUIRED"));

        assertEquals("Edited directly on the server", Files.readString(file));
        assertNoOperation(operationId);
        assertEquals(initialStagingFiles, stagingFileCount());
    }

    @Test
    void rejectsDeleteOfDirectlyRemovedFileWithoutPreparingIt() throws IOException {
        String path = "drift/" + UUID.randomUUID() + ".md";
        int revision = create(path, "Removed outside the Sync API");
        Files.delete(dataDirectories.vault().resolve(path));

        String operationId = "OP-" + UUID.randomUUID();
        given()
                .contentType("application/json")
                .body("""
                        {"operationId":"%s","clientId":"drift-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                        """.formatted(operationId, path, path, revision, hash("Removed outside the Sync API")))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(503)
                .body("error.code", is("RECOVERY_REQUIRED"));

        assertNoOperation(operationId);
    }

    @Test
    void rejectsCreateOverUnrecordedFileWithoutReplacingIt() throws IOException {
        String path = "drift/" + UUID.randomUUID() + ".md";
        Path file = dataDirectories.vault().resolve(path);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "Copied directly into the Vault", StandardCharsets.UTF_8);

        byte[] content = "Client create".getBytes(StandardCharsets.UTF_8);
        String operationId = "OP-" + UUID.randomUUID();
        postContent(createRequest(operationId, path, content), content)
                .then()
                .statusCode(503)
                .body("error.code", is("RECOVERY_REQUIRED"));

        assertEquals("Copied directly into the Vault", Files.readString(file));
        assertNoOperation(operationId);
    }

    @Test
    void rejectsRenameOntoUnrecordedFileWithoutMovingSource() throws IOException {
        String source = "drift/" + UUID.randomUUID() + ".md";
        String destination = "drift/" + UUID.randomUUID() + ".md";
        int revision = create(source, "Rename source");
        Files.writeString(dataDirectories.vault().resolve(destination), "Unrecorded destination", StandardCharsets.UTF_8);

        String operationId = "OP-" + UUID.randomUUID();
        given()
                .contentType("application/json")
                .body("""
                        {"operationId":"%s","clientId":"drift-client","type":"RENAME","sourcePath":"%s","destinationPath":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"},{"path":"%s","state":"UNKNOWN"}]}
                        """.formatted(operationId, source, destination, source, revision, hash("Rename source"), destination))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(503)
                .body("error.code", is("RECOVERY_REQUIRED"));

        assertEquals("Rename source", Files.readString(dataDirectories.vault().resolve(source)));
        assertEquals("Unrecorded destination", Files.readString(dataDirectories.vault().resolve(destination)));
        assertNoOperation(operationId);
    }

    private int create(String path, String text) {
        byte[] content = text.getBytes(StandardCharsets.UTF_8);
        return postContent(createRequest("OP-" + UUID.randomUUID(), path, content), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
    }

    private void assertNoOperation(String operationId) {
        assertFalse(dsl.fetchExists(dsl.selectOne().from(OPERATIONS).where(OPERATIONS.OPERATION_ID.eq(operationId))));
    }

    private long stagingFileCount() throws IOException {
        try (var files = Files.list(dataDirectories.staging())) {
            return files.count();
        }
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
                {"operationId":"%s","clientId":"drift-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }

    private static String hash(String text) {
        return ContentHash.calculate(text.getBytes(StandardCharsets.UTF_8));
    }
}
