package io.vaultdatum.server.sync;

import org.flywaydb.core.Flyway;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Builds server data written by an earlier schema version, before the server under test starts.
 */
final class LegacyDataRoot {

    static final String SCHEMA_VERSION = "7";

    static final String NOTE_PATH = "notes/legacy.md";

    static final String NOTE_TEXT = "Written before the upgrade";

    private LegacyDataRoot() {
    }

    /**
     * Creates a Vault with one recorded file and a database migrated to {@link #SCHEMA_VERSION}.
     */
    static void create(Path root, String vaultId) throws IOException, SQLException {
        Path database = root.resolve("state/sync.db");
        Files.createDirectories(database.getParent());
        Path note = root.resolve("vault").resolve(NOTE_PATH);
        Files.createDirectories(note.getParent());
        byte[] content = NOTE_TEXT.getBytes(StandardCharsets.UTF_8);
        Files.write(note, content);

        Flyway.configure()
                .dataSource("jdbc:sqlite:" + database, "", "")
                .locations("classpath:db/migration")
                .table("schema_migrations")
                .target(SCHEMA_VERSION)
                .load()
                .migrate();

        String hash = ContentHash.calculate(content);
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database);
                Statement statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO vault_metadata VALUES (1, '" + vaultId + "', 1)");
            statement.executeUpdate("INSERT INTO change_journal VALUES "
                    + "(1, 'CREATE', 'OP-legacy', 'CLIENT', 'legacy-client', NULL, NULL, '2026-01-01T00:00:00Z')");
            statement.executeUpdate("INSERT INTO change_effect VALUES (1, 0, '" + NOTE_PATH + "', 'FILE', 'PRESENT', '"
                    + hash + "', " + content.length + ")");
            statement.executeUpdate("INSERT INTO path_state VALUES ('" + NOTE_PATH + "', 'FILE', 'PRESENT', 1, '"
                    + hash + "', " + content.length + ", NULL)");
        }
    }

    /**
     * Turns the data in {@code source} into the current Backup under {@code root}.
     */
    static BackupManifest createBackup(Path source, Path root, String vaultId) throws IOException {
        Path backup = root.resolve("backups/current");
        BackupTree.link(source.resolve("vault"), backup.resolve("vault"));
        Files.createDirectories(backup.resolve("state"));
        Files.copy(source.resolve("state/sync.db"), backup.resolve("state/sync.db"));
        BackupTree.Totals vault = BackupTree.count(backup.resolve("vault"));
        BackupManifest manifest = new BackupManifest(
                vaultId,
                1,
                "2026-01-01T00:00:00Z",
                BackupTrigger.SCHEDULED,
                "test",
                SCHEMA_VERSION,
                vault.files(),
                vault.bytes(),
                ContentHash.calculate(backup.resolve("state/sync.db")).value());
        manifest.write(backup);
        return manifest;
    }
}
