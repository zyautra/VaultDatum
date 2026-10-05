package io.vaultdatum.server.sync;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.jboss.logging.Logger;
import org.jooq.DSLContext;
import org.jooq.Record;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Properties;

/**
 * Keeps exactly one Backup of the last known good server state.
 *
 * <p>A Backup is a consistent copy of the Vault, the Sync State, and the
 * Content History taken while holding the mutation lock. Because only one
 * Backup exists, a refresh first checks that the current state is healthy and
 * keeps the existing Backup otherwise. A new Backup replaces the existing one
 * only after it is complete.</p>
 *
 * <p>Queries use plain SQL against columns that exist in every schema version
 * so the Backup taken before a migration can read the unmigrated database.</p>
 */
@ApplicationScoped
public final class ServerBackup {

    private static final Logger LOG = Logger.getLogger(ServerBackup.class);

    static final String CURRENT = "current";

    static final String PARTIAL = ".partial";

    static final String OLD = ".old";

    /** Directories linked into a Backup. The database is copied separately. */
    static final List<String> LINKED_DIRECTORIES = List.of("vault", "history", "recovery", "staging");

    static final String SYNC_DB = "state/sync.db";

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final Flyway flyway;

    private final String serverVersion;

    public ServerBackup(
            DataDirectories dataDirectories,
            DSLContext dsl,
            Flyway flyway,
            @ConfigProperty(name = "quarkus.application.version", defaultValue = "unknown") String serverVersion) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.flyway = flyway;
        this.serverVersion = serverVersion;
    }

    /**
     * The result of a refresh request.
     */
    public sealed interface Outcome {
    }

    public record Completed(BackupManifest manifest) implements Outcome {
    }

    public record Skipped(String reason) implements Outcome {
    }

    /**
     * Completes or rolls back a replacement interrupted by a server stop and removes an unfinished Backup.
     */
    public void recoverLayout() {
        Path current = backup(CURRENT);
        Path old = backup(OLD);

        try {
            if (Files.isDirectory(old)) {
                if (Files.isDirectory(current)) {
                    BackupTree.delete(old);
                } else {
                    Files.move(old, current, StandardCopyOption.ATOMIC_MOVE);
                }
                VaultFiles.forceDirectory(dataDirectories.backups());
            }
            BackupTree.delete(backup(PARTIAL));
        } catch (IOException exception) {
            throw new ServerBackupException("Could not recover the server Backup directory", exception);
        }
    }

    /**
     * Returns the description of the current Backup, or {@code null} when there is none.
     */
    public BackupManifest current() {
        Path current = backup(CURRENT);

        if (!Files.isDirectory(current)) {
            return null;
        }
        try {
            return BackupManifest.read(current);
        } catch (IOException | RuntimeException exception) {
            throw new ServerBackupException("The current server Backup cannot be read", exception);
        }
    }

    /**
     * Returns whether the database has schema migrations that have not been applied yet.
     */
    public boolean hasPendingMigrationsOnExistingState() {
        var info = flyway.info();
        return info.current() != null && info.pending().length > 0;
    }

    /**
     * Refreshes the Backup when the current state is healthy and differs from the current Backup.
     */
    public Outcome refresh(BackupTrigger trigger) {
        long started = System.nanoTime();
        Path partial = backup(PARTIAL);
        BackupManifest existing = current();
        State state;
        long lockMillis;

        synchronized (MutationLock.INSTANCE) {
            long locked = System.nanoTime();
            state = readState();
            String problem = healthProblem(trigger, state, existing);

            if (problem != null) {
                if ("unchanged".equals(problem)) {
                    LOG.debugf("backup_skipped trigger=%s reason=unchanged", trigger);
                } else {
                    LOG.warnf("backup_skipped trigger=%s reason=%s", trigger, problem);
                }
                return new Skipped(problem);
            }

            try {
                BackupTree.delete(partial);
                Files.createDirectories(partial.resolve("state"));
                dsl.execute("VACUUM INTO ?", partial.resolve(SYNC_DB).toString());
                for (String directory : LINKED_DIRECTORIES) {
                    BackupTree.link(dataDirectories.root().resolve(directory), partial.resolve(directory));
                }
            } catch (IOException | RuntimeException exception) {
                discard(partial);
                LOG.warnf("backup_failed trigger=%s cause=%s", trigger, exception.getClass().getSimpleName());
                throw new ServerBackupException("Could not create the server Backup", exception);
            }
            lockMillis = (System.nanoTime() - locked) / 1_000_000;
        }

        try {
            BackupManifest manifest = describe(partial, trigger, state);
            manifest.write(partial);
            VaultFiles.forceDirectory(partial);
            replaceCurrent(partial);
            LOG.infof("backup_complete trigger=%s revision=%d files=%d bytes=%d durationMs=%d lockMs=%d",
                    trigger, manifest.revision(), manifest.files(), manifest.bytes(),
                    (System.nanoTime() - started) / 1_000_000, lockMillis);
            return new Completed(manifest);
        } catch (IOException | RuntimeException exception) {
            discard(partial);
            LOG.warnf("backup_failed trigger=%s cause=%s", trigger, exception.getClass().getSimpleName());
            throw new ServerBackupException("Could not complete the server Backup", exception);
        }
    }

    private record State(String vaultId, long revision, String schemaVersion) {
    }

    private State readState() {
        Record metadata = dsl.fetchOne("SELECT vault_id, current_revision FROM vault_metadata WHERE id = 1");

        if (metadata == null) {
            throw new ServerBackupException("Vault metadata has not been initialized");
        }

        MigrationInfo applied = flyway.info().current();
        return new State(
                metadata.get(0, String.class),
                metadata.get(1, Long.class),
                applied == null ? "0" : applied.getVersion().getVersion());
    }

    /**
     * Returns why the current state must not replace the Backup, or {@code null}.
     *
     * <p>The health checks protect an existing Backup from being replaced by a
     * damaged state. Without a Backup there is nothing to protect, and a copy
     * of any consistent state is better than none.</p>
     */
    private String healthProblem(BackupTrigger trigger, State state, BackupManifest existing) {
        if (trigger == BackupTrigger.SCHEDULED
                && count("SELECT COUNT(*) FROM operations WHERE status = 'PREPARED'") > 0) {
            return "prepared-operation";
        }
        if (existing == null) {
            return null;
        }
        if (!existing.vaultId().equals(state.vaultId()) && !isPreviousVault(existing.vaultId())) {
            return "vault-mismatch";
        }
        if (state.revision() < existing.revision()) {
            return "revision-behind-backup";
        }
        if (existing.vaultId().equals(state.vaultId()) && existing.revision() == state.revision()) {
            return "unchanged";
        }
        return missingVaultEntry();
    }

    private boolean isPreviousVault(String vaultId) {
        boolean tableExists =
                count("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'previous_vault'") > 0;
        return tableExists && count("SELECT COUNT(*) FROM previous_vault WHERE vault_id = ?", vaultId) > 0;
    }

    private int count(String sql, Object... bindings) {
        return dsl.fetchOne(sql, bindings).get(0, Integer.class);
    }

    /**
     * Returns a problem when a recorded present entry is missing from the Vault or has a different size.
     */
    private String missingVaultEntry() {
        var entries = dsl.fetch("SELECT path, entry_type, size FROM path_state WHERE state = 'PRESENT'");

        for (Record entry : entries) {
            Path path = SyncPath.parse(entry.get(0, String.class)).resolveUnder(dataDirectories.vault());
            boolean file = "FILE".equals(entry.get(1, String.class));

            try {
                BasicFileAttributes attributes =
                        Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (file ? !attributes.isRegularFile() || attributes.size() != entry.get(2, Long.class)
                        : !attributes.isDirectory()) {
                    return "vault-entry-mismatch";
                }
            } catch (NoSuchFileException exception) {
                return "vault-entry-missing";
            } catch (IOException exception) {
                return "vault-entry-unreadable";
            }
        }
        return null;
    }

    private BackupManifest describe(Path partial, BackupTrigger trigger, State state) throws IOException {
        Path database = partial.resolve(SYNC_DB);
        State copied = readCopiedState(database);

        if (!copied.vaultId().equals(state.vaultId()) || copied.revision() != state.revision()) {
            throw new ServerBackupException("The copied database does not match the server state");
        }

        BackupTree.Totals vault = BackupTree.count(partial.resolve("vault"));
        return new BackupManifest(
                state.vaultId(),
                state.revision(),
                Instant.now().truncatedTo(ChronoUnit.SECONDS).toString(),
                trigger,
                serverVersion,
                state.schemaVersion(),
                vault.files(),
                vault.bytes(),
                ContentHash.calculate(database).value());
    }

    private static State readCopiedState(Path database) {
        try (Connection connection = openReadOnly(database);
                PreparedStatement statement = connection.prepareStatement(
                        "SELECT vault_id, current_revision FROM vault_metadata WHERE id = 1");
                ResultSet result = statement.executeQuery()) {
            if (!result.next()) {
                throw new ServerBackupException("The copied database has no Vault metadata");
            }
            return new State(result.getString(1), result.getLong(2), "");
        } catch (SQLException exception) {
            throw new ServerBackupException("The copied database cannot be read", exception);
        }
    }

    /**
     * Opens a SQLite database outside the server connection pool without modifying it.
     */
    static Connection openReadOnly(Path database) throws SQLException {
        Properties properties = new Properties();
        properties.setProperty("open_mode", "1");
        return DriverManager.getConnection("jdbc:sqlite:" + database, properties);
    }

    private void replaceCurrent(Path partial) throws IOException {
        Path current = backup(CURRENT);
        Path old = backup(OLD);

        BackupTree.delete(old);
        if (Files.isDirectory(current)) {
            Files.move(current, old, StandardCopyOption.ATOMIC_MOVE);
        }
        Files.move(partial, current, StandardCopyOption.ATOMIC_MOVE);
        VaultFiles.forceDirectory(dataDirectories.backups());
        BackupTree.delete(old);
    }

    private static void discard(Path partial) {
        try {
            BackupTree.delete(partial);
        } catch (IOException exception) {
            LOG.warnf("backup_partial_cleanup_failed cause=%s", exception.getClass().getSimpleName());
        }
    }

    private Path backup(String name) {
        return dataDirectories.backups().resolve(name);
    }
}
