package io.vaultdatum.server.sync;

import static io.restassured.RestAssured.given;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static org.hamcrest.Matchers.hasItem;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import io.restassured.builder.MultiPartSpecBuilder;
import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.persistence.VaultMetadata;
import io.vaultdatum.server.persistence.VaultMetadataRepository;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.UUID;

@QuarkusTest
@TestProfile(BackupTestProfile.class)
class ServerBackupTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    ServerBackup serverBackup;

    @Inject
    VaultMetadataRepository vaultMetadataRepository;

    @Test
    void keepsAConsistentLinkedCopyThatSurvivesLaterChanges() throws IOException, SQLException {
        String path = "backup-" + UUID.randomUUID() + "/note.md";
        int revision = create(path, "Backed up");

        BackupManifest manifest = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));

        Path current = dataDirectories.backups().resolve("current");
        assertEquals(revision, manifest.revision());
        assertEquals(vaultMetadataRepository.current().vaultId(), manifest.vaultId());
        assertTrue(Files.isSameFile(dataDirectories.vault().resolve(path), current.resolve("vault").resolve(path)));
        assertEquals(manifest, BackupManifest.read(current));
        try (Connection connection = ServerBackup.openReadOnly(current.resolve("state/sync.db"));
                Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery("SELECT current_revision FROM vault_metadata")) {
            result.next();
            assertEquals(revision, result.getLong(1));
        }

        delete(path, revision, "Backed up");

        assertFalse(Files.exists(dataDirectories.vault().resolve(path)));
        assertEquals("Backed up", Files.readString(current.resolve("vault").resolve(path)));
    }

    @Test
    void skipsAnUnchangedState() {
        create("backup-" + UUID.randomUUID() + ".md", "Changed");
        serverBackup.refresh(BackupTrigger.SCHEDULED);

        assertEquals(new ServerBackup.Skipped("unchanged"), serverBackup.refresh(BackupTrigger.SCHEDULED));
    }

    @Test
    void keepsTheExistingBackupWhenAVaultFileIsMissing() throws IOException {
        String path = "backup-" + UUID.randomUUID() + ".md";
        create(path, "Will disappear");
        BackupManifest kept = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));
        create("backup-" + UUID.randomUUID() + ".md", "Newer");
        Path file = dataDirectories.vault().resolve(path);
        Files.delete(file);

        try {
            assertEquals(new ServerBackup.Skipped("vault-entry-missing"),
                    serverBackup.refresh(BackupTrigger.SCHEDULED));
            assertEquals(kept, serverBackup.current());
        } finally {
            Files.writeString(file, "Will disappear", StandardCharsets.UTF_8);
        }
    }

    @Test
    void keepsTheExistingBackupWhenAnOperationIsPrepared() {
        create("backup-" + UUID.randomUUID() + ".md", "Before");
        BackupManifest kept = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));
        create("backup-" + UUID.randomUUID() + ".md", "After");
        String operationId = "OP-" + UUID.randomUUID();
        dsl.insertInto(OPERATIONS)
                .columns(OPERATIONS.OPERATION_ID, OPERATIONS.ACTOR_CLIENT_ID, OPERATIONS.OPERATION_TYPE,
                        OPERATIONS.REQUEST_DIGEST, OPERATIONS.STATUS, OPERATIONS.CREATED_AT)
                .values(operationId, "backup-client", "CREATE", "digest", "PREPARED", Instant.now().toString())
                .execute();

        try {
            assertEquals(new ServerBackup.Skipped("prepared-operation"),
                    serverBackup.refresh(BackupTrigger.SCHEDULED));
            assertEquals(kept, serverBackup.current());
        } finally {
            dsl.deleteFrom(OPERATIONS).where(OPERATIONS.OPERATION_ID.eq(operationId)).execute();
        }
    }

    @Test
    void recoversAReplacementInterruptedAfterTheOldBackupWasMovedAside() throws IOException {
        create("backup-" + UUID.randomUUID() + ".md", "Interrupted");
        BackupManifest kept = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));
        Path backups = dataDirectories.backups();
        Files.move(backups.resolve("current"), backups.resolve(".old"));
        Files.createDirectories(backups.resolve(".partial/vault"));

        serverBackup.recoverLayout();

        assertEquals(kept, serverBackup.current());
        assertFalse(Files.exists(backups.resolve(".old")));
        assertFalse(Files.exists(backups.resolve(".partial")));
    }

    @Test
    void restoresTheBackupIntoAnotherDataRootAndRefusesToRepeat() throws IOException, SQLException {
        String path = "backup-" + UUID.randomUUID() + "/restored.md";
        create(path, "Restore me");
        BackupManifest manifest = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));
        Path root = Files.createTempDirectory("vaultdatum-restore-");
        DataDirectories target = new DataDirectories(root.toString());
        target.initialize();
        Files.writeString(target.vault().resolve("broken.md"), "Replaced state", StandardCharsets.UTF_8);
        BackupTree.link(dataDirectories.backups().resolve("current"), target.backups().resolve("current"));

        BackupManifest restored = new ServerBackupRestore(target, true).restore();

        assertEquals(manifest, restored);
        assertEquals("Restore me", Files.readString(target.vault().resolve(path)));
        assertFalse(Files.exists(target.vault().resolve("broken.md")));
        try (var asideEntries = Files.list(target.backups())) {
            Path aside = asideEntries.filter(entry -> entry.getFileName().toString().startsWith("pre-restore-"))
                    .findFirst()
                    .orElseThrow();
            assertEquals("Replaced state", Files.readString(aside.resolve("vault/broken.md")));
        }

        try (Connection connection = java.sql.DriverManager.getConnection(
                "jdbc:sqlite:" + target.state().resolve("sync.db"));
                Statement statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO previous_vault VALUES ('V-old', '2026-01-01T00:00:00Z', '"
                    + manifest.createdAt() + "')");
        }
        assertThrows(ServerBackupException.class, () -> new ServerBackupRestore(target, true).restore());
        assertEquals("Restore me", Files.readString(target.vault().resolve(path)));
    }

    @Test
    void refusesADamagedBackupWithoutChangingTheState() throws IOException {
        create("backup-" + UUID.randomUUID() + ".md", "Damaged");
        serverBackup.refresh(BackupTrigger.SCHEDULED);
        Path root = Files.createTempDirectory("vaultdatum-restore-");
        DataDirectories target = new DataDirectories(root.toString());
        target.initialize();
        Files.writeString(target.vault().resolve("kept.md"), "Current state", StandardCharsets.UTF_8);
        Path backup = target.backups().resolve("current");
        BackupTree.link(dataDirectories.backups().resolve("current"), backup);
        Files.delete(backup.resolve("state/sync.db"));
        Files.writeString(backup.resolve("state/sync.db"), "not a database", StandardCharsets.UTF_8);

        assertThrows(ServerBackupException.class, () -> new ServerBackupRestore(target, true).restore());

        assertEquals("Current state", Files.readString(target.vault().resolve("kept.md")));
    }

    @Test
    void replacesTheBackupOfARestoredVaultAndReportsThePreviousVaultId() {
        create("backup-" + UUID.randomUUID() + ".md", "Restored vault");
        BackupManifest before = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));

        VaultMetadata replaced = vaultMetadataRepository.replaceAfterRestore(before.createdAt());

        assertNotEquals(before.vaultId(), replaced.vaultId());
        BackupManifest after = completed(serverBackup.refresh(BackupTrigger.SCHEDULED));
        assertEquals(replaced.vaultId(), after.vaultId());
        given()
                .when().get("/api/v1/vault")
                .then()
                .statusCode(200)
                .body("previousVaultIds", hasItem(before.vaultId()));
    }

    private static BackupManifest completed(ServerBackup.Outcome outcome) {
        return assertInstanceOf(ServerBackup.Completed.class, outcome).manifest();
    }

    private static int create(String path, String text) {
        byte[] content = text.getBytes(StandardCharsets.UTF_8);
        String request = """
                {"operationId":"OP-%s","clientId":"backup-client","type":"CREATE","path":"%s","base":[{"path":"%s","state":"UNKNOWN"}],"content":{"contentHash":"%s","size":%d}}
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
                        {"operationId":"OP-%s","clientId":"backup-client","type":"DELETE","path":"%s","base":[{"path":"%s","state":"PRESENT","revision":%d,"contentHash":"%s"}]}
                        """.formatted(UUID.randomUUID(), path, path, revision,
                        ContentHash.calculate(text.getBytes(StandardCharsets.UTF_8))))
                .when().post("/api/v1/operations")
                .then()
                .statusCode(200);
    }
}
