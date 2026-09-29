package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.HISTORY_OBJECT;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.nullValue;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.restassured.response.Response;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHash;
import io.vaultdatum.server.sync.ContentHistory;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

@QuarkusTest
class FileHistoryResourceTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    ContentHistory contentHistory;

    @Test
    void restoresAFileToAnyEarlierVersion() {
        String path = "history/" + UUID.randomUUID() + ".md";
        int first = create(path, "First version");
        int second = modify(path, first, "First version", "Second version");
        int third = modify(path, second, "Second version", "Third version");

        given()
                .queryParam("path", path)
                .when().get("/api/v1/history")
                .then()
                .statusCode(200)
                .body("entries", hasSize(3))
                .body("entries[0].revision", is(third))
                .body("entries[0].type", is("MODIFY"))
                .body("entries[1].contentHash", is(hash("Second version")))
                .body("entries[2].revision", is(first))
                .body("entries[2].contentAvailable", is(true))
                .body("entries[2].actor.clientId", is("history-client"))
                .body("hasMore", is(false));

        assertArrayEquals(bytes("First version"), historyContent(hash("First version")));

        int restored = modify(path, third, "Third version", "First version");

        given()
                .queryParam("path", path)
                .queryParam("limit", 1)
                .when().get("/api/v1/history")
                .then()
                .statusCode(200)
                .body("entries[0].revision", is(restored))
                .body("entries[0].contentHash", is(hash("First version")))
                .body("hasMore", is(true));
        assertArrayEquals(bytes("Third version"), historyContent(hash("Third version")));
    }

    @Test
    void restoresADeletedFileFromHistory() throws IOException {
        String path = "history/" + UUID.randomUUID() + ".md";
        int created = create(path, "Deleted later");
        int deleted = given()
                .contentType("application/json")
                .body("""
                        {"operationId":"OP-%s","clientId":"history-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                        """.formatted(UUID.randomUUID(), path, path, created, hash("Deleted later")))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        given()
                .queryParam("path", path)
                .when().get("/api/v1/history")
                .then()
                .statusCode(200)
                .body("entries[0].state", is("DELETED"))
                .body("entries[0].contentHash", nullValue())
                .body("entries[1].contentAvailable", is(true));

        byte[] content = historyContent(hash("Deleted later"));
        postContent("""
                {"operationId":"OP-%s","clientId":"history-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"DELETED","revision":%d}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(UUID.randomUUID(), path, path, deleted, ContentHash.calculate(content), content.length),
                content)
                .then()
                .statusCode(200);

        assertEquals("Deleted later", Files.readString(dataDirectories.vault().resolve(path)));
    }

    @Test
    void marksTheSourceOfARenamedFile() {
        String source = "history/" + UUID.randomUUID() + ".md";
        String destination = "history/" + UUID.randomUUID() + ".md";
        int created = create(source, "Renamed content");
        given()
                .contentType("application/json")
                .body("""
                        {"operationId":"OP-%s","clientId":"history-client","type":"RENAME","sourcePath":"%s","destinationPath":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"},{"path":"%s","state":"UNKNOWN"}]}
                        """.formatted(UUID.randomUUID(), source, destination, source, created,
                        hash("Renamed content"), destination))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200);

        given()
                .queryParam("path", destination)
                .when().get("/api/v1/history")
                .then()
                .statusCode(200)
                .body("entries", hasSize(1))
                .body("entries[0].type", is("RENAME"))
                .body("entries[0].previousPath", is(source));
    }

    @Test
    void reportsContentThatIsNotKept() {
        given()
                .queryParam("contentHash", hash("Never stored " + UUID.randomUUID()))
                .when().get("/api/v1/history/content")
                .then()
                .statusCode(404)
                .body("error.code", is("CONTENT_NOT_RETAINED"));

        given()
                .queryParam("contentHash", "sha256:not-a-hash")
                .when().get("/api/v1/history/content")
                .then()
                .statusCode(400)
                .body("error.code", is("INVALID_REQUEST"));
    }

    @Test
    void keepsARecoveryArtifactLeftAfterACommit() throws IOException {
        String path = "history/" + UUID.randomUUID() + ".md";
        String original = "Left in recovery " + UUID.randomUUID();
        int created = create(path, original);
        String operationId = "OP-" + UUID.randomUUID();
        modify(operationId, path, created, original, "After the crash");
        Files.delete(objectPath(hash(original)));
        dsl.deleteFrom(HISTORY_OBJECT).where(HISTORY_OBJECT.CONTENT_HASH.eq(hash(original))).execute();
        Files.writeString(dataDirectories.recovery().resolve("modify-" + operationId + ".bak"), original);

        contentHistory.recoverCommittedArtifacts();

        assertFalse(Files.exists(dataDirectories.recovery().resolve("modify-" + operationId + ".bak")));
        assertArrayEquals(bytes(original), historyContent(hash(original)));
    }

    @Test
    void collectsObjectsOlderThanTheRetentionPeriod() throws IOException {
        String content = "Expired " + UUID.randomUUID();
        String contentHash = hash(content);
        Path object = objectPath(contentHash);
        Files.createDirectories(object.getParent());
        Files.writeString(object, content);
        dsl.insertInto(HISTORY_OBJECT)
                .columns(HISTORY_OBJECT.CONTENT_HASH, HISTORY_OBJECT.SIZE, HISTORY_OBJECT.STORED_AT)
                .values(contentHash, (long) content.length(), "2000-01-01T00:00:00Z")
                .execute();

        assertTrue(contentHistory.collectExpired() >= 1);

        assertFalse(Files.exists(object));
        assertFalse(dsl.fetchExists(HISTORY_OBJECT, HISTORY_OBJECT.CONTENT_HASH.eq(contentHash)));
    }

    private int create(String path, String text) {
        byte[] content = bytes(text);
        return postContent("""
                {"operationId":"OP-%s","clientId":"history-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(UUID.randomUUID(), path, path, ContentHash.calculate(content), content.length), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
    }

    private int modify(String path, int revision, String baseText, String text) {
        return modify("OP-" + UUID.randomUUID(), path, revision, baseText, text);
    }

    private int modify(String operationId, String path, int revision, String baseText, String text) {
        byte[] content = bytes(text);
        return postContent("""
                {"operationId":"%s","clientId":"history-client","type":"MODIFY","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, revision, hash(baseText), ContentHash.calculate(content),
                content.length), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
    }

    private static byte[] historyContent(String contentHash) {
        return given()
                .queryParam("contentHash", contentHash)
                .when().get("/api/v1/history/content")
                .then()
                .statusCode(200)
                .header("X-VaultDatum-Content-Hash", contentHash)
                .extract()
                .asByteArray();
    }

    private Path objectPath(String contentHash) {
        String hex = contentHash.substring("sha256:".length());
        return dataDirectories.history().resolve("objects/sha256").resolve(hex.substring(0, 2)).resolve(hex.substring(2));
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

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static String hash(String text) {
        return ContentHash.calculate(bytes(text));
    }
}
