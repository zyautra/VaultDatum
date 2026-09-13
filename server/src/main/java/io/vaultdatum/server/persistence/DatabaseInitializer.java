package io.vaultdatum.server.persistence;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.sync.CreateCoordinator;
import io.vaultdatum.server.sync.DeleteCoordinator;
import io.vaultdatum.server.sync.ModifyCoordinator;
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

    public DatabaseInitializer(
            DataDirectories dataDirectories,
            Flyway flyway,
            VaultMetadataRepository vaultMetadataRepository,
            CreateCoordinator createCoordinator,
            ModifyCoordinator modifyCoordinator,
            DeleteCoordinator deleteCoordinator) {
        this.dataDirectories = dataDirectories;
        this.flyway = flyway;
        this.vaultMetadataRepository = vaultMetadataRepository;
        this.createCoordinator = createCoordinator;
        this.modifyCoordinator = modifyCoordinator;
        this.deleteCoordinator = deleteCoordinator;
    }

    @PostConstruct
    void initialize() {
        dataDirectories.initialize();
        flyway.migrate();
        vaultMetadataRepository.initialize();
        createCoordinator.recoverPreparedCreates();
        modifyCoordinator.recoverPreparedModifies();
        deleteCoordinator.recoverPreparedDeletes();
    }
}
