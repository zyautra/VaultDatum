package io.vaultdatum.server.sync;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.empty;
import static org.hamcrest.Matchers.is;
import static org.junit.jupiter.api.Assertions.assertEquals;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;

@QuarkusTest
@TestProfile(PreMigrationBackupTestProfile.class)
class PreMigrationBackupTest {

    @Inject
    ServerBackup serverBackup;

    @Test
    void backsUpTheUnmigratedStateBeforeChangingTheSchema() {
        BackupManifest backup = serverBackup.current();

        assertEquals(BackupTrigger.PRE_MIGRATION, backup.trigger());
        assertEquals(LegacyDataRoot.SCHEMA_VERSION, backup.schemaVersion());
        assertEquals(PreMigrationBackupTestProfile.VAULT_ID, backup.vaultId());
        assertEquals(1, backup.revision());
        assertEquals(1, backup.files());
        given()
                .when().get("/api/v1/vault")
                .then()
                .statusCode(200)
                .body("vaultId", is(PreMigrationBackupTestProfile.VAULT_ID))
                .body("previousVaultIds", empty());
    }
}
