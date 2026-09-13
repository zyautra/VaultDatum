package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.MANIFEST;
import static org.hamcrest.Matchers.is;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.restassured.response.Response;
import io.vaultdatum.server.sync.ContentHash;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;

@QuarkusTest
class ManifestResourceTest {

    @Inject
    DSLContext dsl;

    @Test
    void snapshotsPresentAndDeletedPathsWithoutFollowingLaterChanges() {
        String presentPath = path("present");
        byte[] presentContent = "Manifest present content".getBytes(StandardCharsets.UTF_8);
        String presentHash = ContentHash.calculate(presentContent);
        int presentRevision = create(presentPath, presentContent);

        String deletedPath = path("deleted");
        byte[] deletedContent = "Manifest deleted content".getBytes(StandardCharsets.UTF_8);
        String deletedHash = ContentHash.calculate(deletedContent);
        int deletedRevision = create(deletedPath, deletedContent);
        int deleteRevision = delete(deletedPath, deletedRevision, deletedHash);

        Response created = given()
                .when().post("/api/v1/manifests")
                .then()
                .statusCode(201)
                .body("snapshotRevision", is(deleteRevision))
                .extract()
                .response();
        String manifestId = created.path("manifestId");

        byte[] modifiedContent = "Manifest later content".getBytes(StandardCharsets.UTF_8);
        modify(presentPath, presentRevision, presentHash, modifiedContent);

        given()
                .when().get("/api/v1/manifests/{manifestId}", manifestId)
                .then()
                .statusCode(200)
                .body("manifestId", is(manifestId))
                .body("snapshotRevision", is(deleteRevision))
                .body("entries.find { it.path == '%s' }.entryType".formatted(presentPath), is("FILE"))
                .body("entries.find { it.path == '%s' }.state".formatted(presentPath), is("PRESENT"))
                .body("entries.find { it.path == '%s' }.revision".formatted(presentPath), is(presentRevision))
                .body("entries.find { it.path == '%s' }.contentHash".formatted(presentPath), is(presentHash))
                .body("entries.find { it.path == '%s' }.state".formatted(deletedPath), is("DELETED"))
                .body("entries.find { it.path == '%s' }.revision".formatted(deletedPath), is(deleteRevision));

        given()
                .queryParam("path", presentPath)
                .queryParam("revision", presentRevision)
                .queryParam("hash", presentHash)
                .when().get("/api/v1/content")
                .then()
                .statusCode(409)
                .body("error.code", is("STATE_CHANGED"));
    }

    @Test
    void rejectsExpiredAndUnknownManifests() {
        String manifestId = given()
                .when().post("/api/v1/manifests")
                .then()
                .statusCode(201)
                .extract()
                .path("manifestId");
        dsl.update(MANIFEST)
                .set(MANIFEST.EXPIRES_AT, Instant.now().minusSeconds(1).toString())
                .where(MANIFEST.MANIFEST_ID.eq(manifestId))
                .execute();

        given()
                .when().get("/api/v1/manifests/{manifestId}", manifestId)
                .then()
                .statusCode(409)
                .body("error.code", is("MANIFEST_EXPIRED"));

        given()
                .when().get("/api/v1/manifests/{manifestId}", "M-" + UUID.randomUUID())
                .then()
                .statusCode(404)
                .body("error.code", is("MANIFEST_NOT_FOUND"));
    }

    private static int create(String path, byte[] content) {
        return post(createRequest("OP-" + UUID.randomUUID(), path, content), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
    }

    private static int modify(String path, int revision, String contentHash, byte[] content) {
        return post(modifyRequest("OP-" + UUID.randomUUID(), path, revision, contentHash, content), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
    }

    private static int delete(String path, int revision, String contentHash) {
        return given()
                .contentType("application/json")
                .body(deleteRequest("OP-" + UUID.randomUUID(), path, revision, contentHash))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
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

    private static String createRequest(String operationId, String path, byte[] content) {
        return """
                {"operationId":"%s","clientId":"manifest-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }

    private static String modifyRequest(
            String operationId,
            String path,
            int revision,
            String baseHash,
            byte[] content) {
        return """
                {"operationId":"%s","clientId":"manifest-client","type":"MODIFY","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(
                operationId,
                path,
                path,
                revision,
                baseHash,
                ContentHash.calculate(content),
                content.length);
    }

    private static String deleteRequest(String operationId, String path, int revision, String contentHash) {
        return """
                {"operationId":"%s","clientId":"manifest-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                """.formatted(operationId, path, path, revision, contentHash);
    }

    private static String path(String prefix) {
        return "manifest/" + prefix + "-" + UUID.randomUUID() + ".md";
    }
}
