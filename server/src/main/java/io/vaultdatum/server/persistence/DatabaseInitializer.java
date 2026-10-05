package io.vaultdatum.server.persistence;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.BackupManifest;
import io.vaultdatum.server.sync.BackupTrigger;
import io.vaultdatum.server.sync.ContentHistory;
import io.vaultdatum.server.sync.CreateCoordinator;
import io.vaultdatum.server.sync.DeleteCoordinator;
import io.vaultdatum.server.sync.DirectoryCoordinator;
import io.vaultdatum.server.sync.ImplicitParentDirectories;
import io.vaultdatum.server.sync.InitialVaultImport;
import io.vaultdatum.server.sync.ModifyCoordinator;
import io.vaultdatum.server.sync.PathChangeCoordinator;
import io.vaultdatum.server.sync.ServerBackup;
import io.vaultdatum.server.sync.ServerBackupRestore;
import io.vaultdatum.server.sync.ServerBackupScheduler;
import io.vaultdatum.server.sync.VaultIntegrityScan;
import io.quarkus.runtime.Startup;
import jakarta.annotation.PostConstruct;
import jakarta.enterprise.context.ApplicationScoped;
import org.flywaydb.core.Flyway;
import org.jboss.logging.Logger;

@Startup
@ApplicationScoped
public final class DatabaseInitializer {

    private static final Logger LOG = Logger.getLogger(DatabaseInitializer.class);

    private final DataDirectories dataDirectories;

    private final Flyway flyway;

    private final VaultMetadataRepository vaultMetadataRepository;

    private final CreateCoordinator createCoordinator;

    private final ModifyCoordinator modifyCoordinator;

    private final DeleteCoordinator deleteCoordinator;

    private final PathChangeCoordinator pathChangeCoordinator;

    private final DirectoryCoordinator directoryCoordinator;

    private final ContentHistory contentHistory;

    private final ImplicitParentDirectories implicitParents;

    private final InitialVaultImport initialVaultImport;

    private final VaultIntegrityScan integrityScan;

    private final ServerBackup serverBackup;

    private final ServerBackupRestore backupRestore;

    private final ServerBackupScheduler backupScheduler;

    public DatabaseInitializer(
            DataDirectories dataDirectories,
            Flyway flyway,
            VaultMetadataRepository vaultMetadataRepository,
            CreateCoordinator createCoordinator,
            ModifyCoordinator modifyCoordinator,
            DeleteCoordinator deleteCoordinator,
            PathChangeCoordinator pathChangeCoordinator,
            DirectoryCoordinator directoryCoordinator,
            ContentHistory contentHistory,
            ImplicitParentDirectories implicitParents,
            InitialVaultImport initialVaultImport,
            VaultIntegrityScan integrityScan,
            ServerBackup serverBackup,
            ServerBackupRestore backupRestore,
            ServerBackupScheduler backupScheduler) {
        this.dataDirectories = dataDirectories;
        this.flyway = flyway;
        this.vaultMetadataRepository = vaultMetadataRepository;
        this.createCoordinator = createCoordinator;
        this.modifyCoordinator = modifyCoordinator;
        this.deleteCoordinator = deleteCoordinator;
        this.pathChangeCoordinator = pathChangeCoordinator;
        this.directoryCoordinator = directoryCoordinator;
        this.contentHistory = contentHistory;
        this.implicitParents = implicitParents;
        this.initialVaultImport = initialVaultImport;
        this.integrityScan = integrityScan;
        this.serverBackup = serverBackup;
        this.backupRestore = backupRestore;
        this.backupScheduler = backupScheduler;
    }

    @PostConstruct
    void initialize() {
        dataDirectories.initialize();
        serverBackup.recoverLayout();
        BackupManifest restored = backupRestore.restoreIfRequested();
        dataDirectories.initialize();
        backUpBeforeMigration();
        flyway.migrate();
        vaultMetadataRepository.initialize();
        if (restored != null) {
            VaultMetadata replaced = vaultMetadataRepository.replaceAfterRestore(restored.createdAt());
            LOG.infof("restore_complete previousVaultId=%s vaultId=%s revision=%d",
                    restored.vaultId(), replaced.vaultId(), replaced.currentRevision());
        }
        createCoordinator.recoverPreparedCreates();
        modifyCoordinator.recoverPreparedModifies();
        deleteCoordinator.recoverPreparedDeletes();
        pathChangeCoordinator.recoverPreparedPathChanges();
        directoryCoordinator.recoverPreparedDirectories();
        contentHistory.recoverCommittedArtifacts();
        contentHistory.collectExpired();
        implicitParents.pruneLeftovers();
        initialVaultImport.runIfRequested();
        integrityScan.scan();
        backupScheduler.start();
    }

    /**
     * Keeps a Backup of the existing state before its schema changes.
     *
     * <p>A healthy state replaces the Backup and an unhealthy state keeps the
     * existing one. If the Backup cannot be created, startup fails before the
     * schema is changed.</p>
     */
    private void backUpBeforeMigration() {
        if (serverBackup.hasPendingMigrationsOnExistingState()) {
            serverBackup.refresh(BackupTrigger.PRE_MIGRATION);
        }
    }
}
