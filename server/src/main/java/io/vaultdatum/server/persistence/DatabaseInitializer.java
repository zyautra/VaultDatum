package io.vaultdatum.server.persistence;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.ContentHistory;
import io.vaultdatum.server.sync.CreateCoordinator;
import io.vaultdatum.server.sync.DeleteCoordinator;
import io.vaultdatum.server.sync.DirectoryCoordinator;
import io.vaultdatum.server.sync.ImplicitParentDirectories;
import io.vaultdatum.server.sync.InitialVaultImport;
import io.vaultdatum.server.sync.ModifyCoordinator;
import io.vaultdatum.server.sync.PathChangeCoordinator;
import io.vaultdatum.server.sync.VaultIntegrityScan;
import io.quarkus.runtime.Startup;
import jakarta.annotation.PostConstruct;
import jakarta.enterprise.context.ApplicationScoped;
import org.flywaydb.core.Flyway;

@Startup
@ApplicationScoped
public final class DatabaseInitializer {

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
            VaultIntegrityScan integrityScan) {
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
    }

    @PostConstruct
    void initialize() {
        dataDirectories.initialize();
        flyway.migrate();
        vaultMetadataRepository.initialize();
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
    }
}
