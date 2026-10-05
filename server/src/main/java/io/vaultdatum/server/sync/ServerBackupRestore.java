package io.vaultdatum.server.sync;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

/**
 * Replaces the server data with the current Backup when explicitly requested at startup.
 *
 * <p>A restore replaces whole directories and never turns Vault content into
 * changes. It runs before the database is opened. The replaced state is moved
 * aside, never deleted, and the Backup itself is left unchanged. After the
 * database is migrated, the caller must give the restored Vault a new Vault ID
 * so that no client keeps a cursor that the restored journal would reuse.</p>
 */
@ApplicationScoped
public final class ServerBackupRestore {

    private static final Logger LOG = Logger.getLogger(ServerBackupRestore.class);

    private static final List<String> RESTORED_DIRECTORIES = List.of("vault", "state", "history", "recovery", "staging");

    private static final DateTimeFormatter DIRECTORY_TIME =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC);

    private final DataDirectories dataDirectories;

    private final boolean requested;

    public ServerBackupRestore(
            DataDirectories dataDirectories,
            @ConfigProperty(name = "vaultdatum.restore-backup", defaultValue = "false") boolean requested) {
        this.dataDirectories = dataDirectories;
        this.requested = requested;
    }

    /**
     * Restores the current Backup if requested and returns its description, or {@code null}.
     */
    public BackupManifest restoreIfRequested() {
        return requested ? restore() : null;
    }

    BackupManifest restore() {
        Path backup = dataDirectories.backups().resolve(ServerBackup.CURRENT);
        BackupManifest manifest = verify(backup);
        requireNotAlreadyRestored(manifest);

        Path root = dataDirectories.root();
        Path aside = dataDirectories.backups().resolve(
                "pre-restore-" + DIRECTORY_TIME.format(Instant.now().truncatedTo(ChronoUnit.SECONDS)));
        List<String> moved = new ArrayList<>();
        List<String> created = new ArrayList<>();

        try {
            Files.createDirectories(aside);
            for (String directory : RESTORED_DIRECTORIES) {
                Path live = root.resolve(directory);
                if (Files.exists(live, LinkOption.NOFOLLOW_LINKS)) {
                    Files.move(live, aside.resolve(directory), StandardCopyOption.ATOMIC_MOVE);
                    moved.add(directory);
                }
            }
            VaultFiles.forceDirectory(root);

            for (String directory : ServerBackup.LINKED_DIRECTORIES) {
                created.add(directory);
                BackupTree.link(backup.resolve(directory), root.resolve(directory));
            }
            created.add("state");
            Files.createDirectories(root.resolve("state"));
            Files.copy(backup.resolve(ServerBackup.SYNC_DB), root.resolve(ServerBackup.SYNC_DB));
            ContentHash.HashedContent copied = ContentHash.calculate(root.resolve(ServerBackup.SYNC_DB));
            if (!copied.value().equals(manifest.syncDbHash())) {
                throw new IOException("The restored database does not match the Backup");
            }
            VaultFiles.forceDirectory(root.resolve("state"));
            VaultFiles.forceDirectory(root);
        } catch (IOException | RuntimeException exception) {
            rollBack(root, aside, moved, created);
            LOG.errorf("restore_rejected reason=restore-failed cause=%s", exception.getClass().getSimpleName());
            throw new ServerBackupException("Could not restore the server Backup; the previous state was kept",
                    exception);
        }

        LOG.infof("restore_files_complete revision=%d files=%d previousState=%s",
                manifest.revision(), manifest.files(), aside.getFileName());
        return manifest;
    }

    private static BackupManifest verify(Path backup) {
        if (!Files.isDirectory(backup)) {
            throw rejected("no-backup", "There is no server Backup to restore");
        }

        BackupManifest manifest;
        try {
            manifest = BackupManifest.read(backup);
        } catch (IOException | RuntimeException exception) {
            throw rejected("unreadable-description", "The server Backup description cannot be read");
        }

        try {
            ContentHash.HashedContent database = ContentHash.calculate(backup.resolve(ServerBackup.SYNC_DB));
            if (!database.value().equals(manifest.syncDbHash())) {
                throw rejected("database-hash-mismatch", "The server Backup database is damaged");
            }
            BackupTree.Totals vault = BackupTree.count(backup.resolve("vault"));
            if (vault.files() != manifest.files() || vault.bytes() != manifest.bytes()) {
                throw rejected("vault-mismatch", "The server Backup Vault does not match its description");
            }
        } catch (IOException exception) {
            throw rejected("unreadable-backup", "The server Backup cannot be read");
        }
        return manifest;
    }

    /**
     * Refuses to restore the same Backup over a state that was already restored from it.
     *
     * <p>A missing or unreadable database cannot have been restored from this
     * Backup; restoring then is safe because the current state is moved aside.</p>
     */
    private void requireNotAlreadyRestored(BackupManifest manifest) {
        Path database = dataDirectories.root().resolve(ServerBackup.SYNC_DB);
        if (!Files.isRegularFile(database)) {
            return;
        }

        try (Connection connection = ServerBackup.openReadOnly(database);
                PreparedStatement statement = connection.prepareStatement(
                        "SELECT COUNT(*) FROM previous_vault WHERE restored_backup_created_at = ?")) {
            statement.setString(1, manifest.createdAt());
            try (ResultSet result = statement.executeQuery()) {
                if (result.next() && result.getInt(1) > 0) {
                    throw rejected("already-restored",
                            "The server was already restored from this Backup; turn off the restore flag");
                }
            }
        } catch (SQLException exception) {
            LOG.debugf("restore_previous_state_unreadable cause=%s", exception.getClass().getSimpleName());
        }
    }

    private static void rollBack(Path root, Path aside, List<String> moved, List<String> created) {
        try {
            for (String directory : created) {
                BackupTree.delete(root.resolve(directory));
            }
            for (String directory : moved) {
                Files.move(aside.resolve(directory), root.resolve(directory), StandardCopyOption.ATOMIC_MOVE);
            }
            BackupTree.delete(aside);
            VaultFiles.forceDirectory(root);
        } catch (IOException | RuntimeException exception) {
            LOG.errorf("restore_rollback_failed previousState=%s cause=%s",
                    aside.getFileName(), exception.getClass().getSimpleName());
        }
    }

    private static ServerBackupException rejected(String reason, String message) {
        LOG.errorf("restore_rejected reason=%s", reason);
        return new ServerBackupException(message);
    }
}
