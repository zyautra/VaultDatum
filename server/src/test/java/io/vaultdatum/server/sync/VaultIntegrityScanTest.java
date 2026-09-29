package io.vaultdatum.server.sync;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;
import static org.junit.jupiter.api.Assertions.assertEquals;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.builder.MultiPartSpecBuilder;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.VaultIntegrityScan.Drift;
import io.vaultdatum.server.sync.VaultIntegrityScan.DriftKind;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

@QuarkusTest
class VaultIntegrityScanTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    VaultIntegrityScan integrityScan;

    @Test
    void reportsDriftWithoutChangingState() throws IOException {
        String directory = "integrity-" + UUID.randomUUID();
        String unknownDirectory = "integrity-unknown-" + UUID.randomUUID();
        create(directory + "/edited.md", "Recorded content");
        create(directory + "/removed.md", "Recorded content");
        create(directory + "/intact.md", "Recorded content");
        Path vault = dataDirectories.vault();
        Files.writeString(vault.resolve(directory + "/edited.md"), "Edited directly", StandardCharsets.UTF_8);
        Files.delete(vault.resolve(directory + "/removed.md"));
        Files.writeString(vault.resolve(directory + "/copied.md"), "Copied directly", StandardCharsets.UTF_8);
        Files.createDirectories(vault.resolve(directory + "/.git/refs"));
        Files.writeString(vault.resolve(directory + "/.git/HEAD"), "ref: refs/heads/main", StandardCharsets.UTF_8);
        Files.createDirectories(vault.resolve(unknownDirectory));
        Files.writeString(vault.resolve(unknownDirectory + "/note.md"), "Copied directly", StandardCharsets.UTF_8);
        long revision = currentRevision();

        List<Drift> drifts = integrityScan.scan().stream()
                .filter(drift -> drift.path().startsWith(directory) || drift.path().startsWith(unknownDirectory))
                .toList();

        assertEquals(List.of(
                new Drift(directory + "/.git", DriftKind.UNKNOWN_ENTRY),
                new Drift(directory + "/copied.md", DriftKind.UNKNOWN_ENTRY),
                new Drift(directory + "/edited.md", DriftKind.HASH_MISMATCH),
                new Drift(directory + "/removed.md", DriftKind.MISSING),
                new Drift(unknownDirectory, DriftKind.UNKNOWN_ENTRY)), drifts);
        assertEquals(revision, currentRevision());
        assertEquals("Edited directly", Files.readString(vault.resolve(directory + "/edited.md")));
    }

    private long currentRevision() {
        return dsl.select(VAULT_METADATA.CURRENT_REVISION)
                .from(VAULT_METADATA)
                .fetchSingle(VAULT_METADATA.CURRENT_REVISION);
    }

    private static void create(String path, String text) {
        byte[] content = text.getBytes(StandardCharsets.UTF_8);
        String request = """
                {"operationId":"OP-%s","clientId":"integrity-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
                """.formatted(UUID.randomUUID(), path, path, ContentHash.calculate(content), content.length);
        given()
                .multiPart(new MultiPartSpecBuilder(request)
                        .controlName("operation")
                        .mimeType("application/json")
                        .build())
                .multiPart("content", "content.bin", content, "application/octet-stream")
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200);
    }
}
