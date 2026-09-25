package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.nullValue;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.restassured.response.Response;
import io.vaultdatum.server.sync.ContentHash;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

@QuarkusTest
class PathStateResourceTest {

    @Test
    void returnsUnknownPresentAndDeletedFileStates() {
        String path = "path-state/" + UUID.randomUUID() + ".md";

        given()
                .queryParam("path", path)
                .when().get("/api/v1/path-state")
                .then()
                .statusCode(200)
                .body("path", is(path))
                .body("state", is("UNKNOWN"))
                .body("entryType", nullValue())
                .body("revision", nullValue());

        byte[] content = "Path state content".getBytes(StandardCharsets.UTF_8);
        String contentHash = ContentHash.calculate(content);
        int createdRevision = post(createRequest("OP-" + UUID.randomUUID(), path, content), content)
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        given()
                .queryParam("path", path)
                .when().get("/api/v1/path-state")
                .then()
                .statusCode(200)
                .body("path", is(path))
                .body("entryType", is("FILE"))
                .body("state", is("PRESENT"))
                .body("revision", is(createdRevision))
                .body("contentHash", is(contentHash))
                .body("size", is(content.length));

        int deletedRevision = given()
                .contentType("application/json")
                .body(deleteRequest("OP-" + UUID.randomUUID(), path, createdRevision, contentHash))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        given()
                .queryParam("path", path)
                .when().get("/api/v1/path-state")
                .then()
                .statusCode(200)
                .body("path", is(path))
                .body("entryType", is("FILE"))
                .body("state", is("DELETED"))
                .body("revision", is(deletedRevision))
                .body("contentHash", nullValue())
                .body("size", nullValue());
    }

    @Test
    void returnsPresentDirectoryStateAndRejectsExcludedPaths() {
        String path = "path-state-directory-" + UUID.randomUUID();
        int createdRevision = given()
                .contentType("application/json")
                .body(directoryCreateRequest("OP-" + UUID.randomUUID(), path))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");

        given()
                .queryParam("path", path)
                .when().get("/api/v1/path-state")
                .then()
                .statusCode(200)
                .body("path", is(path))
                .body("entryType", is("DIRECTORY"))
                .body("state", is("PRESENT"))
                .body("revision", is(createdRevision))
                .body("contentHash", nullValue())
                .body("size", nullValue());

        given()
                .queryParam("path", ".obsidian/plugins/vaultdatum")
                .when().get("/api/v1/path-state")
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
                {"operationId":"%s","clientId":"path-state-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(operationId, path, path, ContentHash.calculate(content), content.length);
    }

    private static String deleteRequest(String operationId, String path, int revision, String contentHash) {
        return """
                {"operationId":"%s","clientId":"path-state-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                """.formatted(operationId, path, path, revision, contentHash);
    }

    private static String directoryCreateRequest(String operationId, String path) {
        return """
                {"operationId":"%s","clientId":"path-state-client","type":"CREATE","entryType":"DIRECTORY","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}]}
                """.formatted(operationId, path, path);
    }
}
