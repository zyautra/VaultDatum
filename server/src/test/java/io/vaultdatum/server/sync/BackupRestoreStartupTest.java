package io.vaultdatum.server.sync;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.not;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

@QuarkusTest
@TestProfile(RestoreStartupTestProfile.class)
class BackupRestoreStartupTest {

    @Inject
    DSLContext dsl;

    @Inject
    VaultIntegrityScan integrityScan;

    @Test
    void restoresTheBackupAsANewVaultAndKeepsTheReplacedState() throws IOException {
        Path root = RestoreStartupTestProfile.DATA_ROOT;

        given()
                .when().get("/api/v1/vault")
                .then()
                .statusCode(200)
                .body("vaultId", not(RestoreStartupTestProfile.BACKUP_VAULT_ID))
                .body("currentRevision", is(1))
                .body("previousVaultIds", contains(RestoreStartupTestProfile.BACKUP_VAULT_ID));
        assertEquals(List.of(LegacyDataRoot.NOTE_PATH), dsl.select(PATH_STATE.PATH).from(PATH_STATE)
                .fetch(PATH_STATE.PATH));
        assertEquals(LegacyDataRoot.NOTE_TEXT, Files.readString(root.resolve("vault").resolve(LegacyDataRoot.NOTE_PATH)));
        assertFalse(Files.exists(root.resolve("vault/damaged.md")));
        assertEquals(List.of(), integrityScan.scan());
        try (var entries = Files.list(root.resolve("backups"))) {
            Path aside = entries.filter(entry -> entry.getFileName().toString().startsWith("pre-restore-"))
                    .findFirst()
                    .orElseThrow();
            assertTrue(Files.isRegularFile(aside.resolve("vault/damaged.md")));
        }
    }
}
