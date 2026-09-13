package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.restassured.response.Response;
import io.vaultdatum.server.sync.ContentHash;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

@QuarkusTest
class ChangeAndContentResourceTest {

    @Test
    void listsCommittedChangesInRevisionOrder() {
        byte[] firstContent = "First change".getBytes(StandardCharsets.UTF_8);
        byte[] secondContent = "Second change".getBytes(StandardCharsets.UTF_8);
        String firstPath = "changes/" + UUID.randomUUID() + "-first.md";
        String secondPath = "changes/" + UUID.randomUUID() + "-second.md";

        int firstRevision = post(createRequest("OP-" + UUID.randomUUID(), firstPath, firstContent), firstContent)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
        int secondRevision = post(createRequest("OP-" + UUID.randomUUID(), secondPath, secondContent), secondContent)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        given()
                .queryParam("after", firstRevision - 1)
                .queryParam("limit", 2)
                .when().get("/api/v1/changes")
                .then()
                .statusCode(200)
                .body("fromExclusive", is(firstRevision - 1))
                .body("toInclusive", is(secondRevision))
                .body("hasMore", is(false))
                .body("changes.size()", is(2))
                .body("changes[0].revision", is(firstRevision))
                .body("changes[0].type", is("CREATE"))
                .body("changes[0].effects[0].path", is(firstPath))
                .body("changes[0].effects[0].state", is("PRESENT"))
                .body("changes[0].effects[0].contentHash", is(ContentHash.calculate(firstContent)))
                .body("changes[1].revision", is(secondRevision))
                .body("changes[1].effects[0].path", is(secondPath));
    }

    @Test
    void downloadsOnlyTheCurrentExpectedContent() {
        byte[] content = "Download this exact content".getBytes(StandardCharsets.UTF_8);
        String path = "content/" + UUID.randomUUID() + ".md";
        String contentHash = ContentHash.calculate(content);
        int revision = post(createRequest("OP-" + UUID.randomUUID(), path, content), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        Response response = given()
                .queryParam("path", path)
                .queryParam("revision", revision)
                .queryParam("hash", contentHash)
                .when().get("/api/v1/content");

        response.then()
                .statusCode(200)
                .header("X-VaultDatum-Content-Hash", contentHash)
                .header("Content-Type", "application/octet-stream");
        assertArrayEquals(content, response.asByteArray());

        given()
                .queryParam("path", path)
                .queryParam("revision", revision + 1)
                .queryParam("hash", contentHash)
                .when().get("/api/v1/content")
                .then()
                .statusCode(409)
                .body("error.code", is("STATE_CHANGED"));
    }

    @Test
    void rejectsInvalidChangeCursors() {
        given()
                .queryParam("after", -1)
                .when().get("/api/v1/changes")
                .then()
                .statusCode(400)
                .body("error.code", is("INVALID_REQUEST"));
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
                {"operationId":"%s","clientId":"reader-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }
}
