package io.vaultdatum.server.api;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHash;
import io.vaultdatum.server.sync.ImplicitParentDirectories;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

@QuarkusTest
class ImplicitParentDirectoriesTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    ImplicitParentDirectories implicitParents;

    @Test
    void removesEmptyImplicitParentsAfterTheLastFileIsDeleted() {
        String root = "implicit-" + UUID.randomUUID();
        String path = root + "/nested/note.md";
        int revision = create(path, "Only file");

        delete(path, revision, "Only file");

        assertFalse(Files.exists(vault(root)));
    }

    @Test
    void keepsAParentThatStillHasEntries() {
        String root = "implicit-" + UUID.randomUUID();
        int revision = create(root + "/first.md", "First");
        create(root + "/second.md", "Second");

        delete(root + "/first.md", revision, "First");

        assertTrue(Files.isDirectory(vault(root)));
    }

    @Test
    void keepsAnExplicitlyCreatedDirectory() {
        String directory = "explicit-" + UUID.randomUUID();
        createDirectory(directory);
        int revision = create(directory + "/note.md", "Inside an explicit directory");

        delete(directory + "/note.md", revision, "Inside an explicit directory");

        assertTrue(Files.isDirectory(vault(directory)));
    }

    @Test
    void removesTheSourceParentAfterAMoveAway() {
        String source = "implicit-" + UUID.randomUUID() + "/note.md";
        String destination = "moved-" + UUID.randomUUID() + "/note.md";
        int revision = create(source, "Moving away");

        given()
                .contentType("application/json")
                .body("""
                        {"operationId":"OP-%s","clientId":"parent-client","type":"MOVE","sourcePath":"%s","destinationPath":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"},{"path":"%s","state":"UNKNOWN"}]}
                        """.formatted(UUID.randomUUID(), source, destination, source, revision, hash("Moving away"),
                        destination))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200);

        assertFalse(Files.exists(vault(source).getParent()));
        assertTrue(Files.isRegularFile(vault(destination)));
    }

    @Test
    void allowsCreatingADirectoryWhereAnImplicitParentWasRemoved() {
        String root = "implicit-" + UUID.randomUUID();
        int revision = create(root + "/note.md", "Last file");
        delete(root + "/note.md", revision, "Last file");

        createDirectory(root);

        assertTrue(Files.isDirectory(vault(root)));
    }

    @Test
    void removesLeftoverParentsOnlyWhenADeletedEntryProvesThem() throws IOException {
        String leftover = "leftover-" + UUID.randomUUID();
        String unrelated = "unrelated-" + UUID.randomUUID();
        Files.createDirectories(vault(leftover + "/inner"));
        Files.createDirectories(vault(unrelated));
        dsl.insertInto(PATH_STATE)
                .columns(PATH_STATE.PATH, PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION)
                .values(leftover + "/inner/gone.md", "FILE", "DELETED", 1L)
                .execute();

        implicitParents.pruneLeftovers();

        assertFalse(Files.exists(vault(leftover)));
        assertTrue(Files.isDirectory(vault(unrelated)));
    }

    @Test
    void keepsAnEmptyLookingParentThatHoldsHiddenFiles() throws IOException {
        String root = "implicit-" + UUID.randomUUID();
        int revision = create(root + "/note.md", "Visible");
        Files.writeString(vault(root + "/.DS_Store"), "metadata");

        delete(root + "/note.md", revision, "Visible");

        assertTrue(Files.isRegularFile(vault(root + "/.DS_Store")));
    }

    private Path vault(String path) {
        return dataDirectories.vault().resolve(path);
    }

    private static int create(String path, String text) {
        byte[] content = text.getBytes(StandardCharsets.UTF_8);
        String request = """
                {"operationId":"OP-%s","clientId":"parent-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(UUID.randomUUID(), path, path, ContentHash.calculate(content), content.length);
        return given()
                .multiPart(new MultiPartSpecBuilder(request)
                        .controlName("operation")
                        .mimeType("application/json")
                        .build())
                .multiPart("content", "content.bin", content, "application/octet-stream")
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200)
                .extract()
                .path("resultRevision");
    }

    private static void delete(String path, int revision, String text) {
        given()
                .contentType("application/json")
                .body("""
                        {"operationId":"OP-%s","clientId":"parent-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                        """.formatted(UUID.randomUUID(), path, path, revision, hash(text)))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200);
    }

    private static void createDirectory(String path) {
        given()
                .contentType("application/json")
                .body("""
                        {"operationId":"OP-%s","clientId":"parent-client","type":"CREATE","entryType":"DIRECTORY","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}]}
                        """.formatted(UUID.randomUUID(), path, path))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200);
    }

    private static String hash(String text) {
        return ContentHash.calculate(text.getBytes(StandardCharsets.UTF_8));
    }
}
