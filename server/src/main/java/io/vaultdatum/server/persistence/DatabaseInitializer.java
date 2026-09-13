package io.vaultdatum.server.persistence;

import io.vaultdatum.server.config.DataDirectories;
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

    public DatabaseInitializer(
            DataDirectories dataDirectories,
            Flyway flyway,
            VaultMetadataRepository vaultMetadataRepository) {
        this.dataDirectories = dataDirectories;
        this.flyway = flyway;
        this.vaultMetadataRepository = vaultMetadataRepository;
    }

    @PostConstruct
    void initialize() {
        dataDirectories.initialize();
        flyway.migrate();
        vaultMetadataRepository.initialize();
    }
}
