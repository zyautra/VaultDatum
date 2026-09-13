package io.vaultdatum.server.persistence;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.vaultdatum.server.config.DataDirectories;
import org.flywaydb.core.Flyway;
import org.jooq.DSLContext;
import org.jooq.SQLDialect;
import org.jooq.impl.DSL;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

class VaultMetadataRepositoryTest {

    @Test
    void configuresSqliteDurabilityPragmas(@TempDir Path temporaryDirectory) throws SQLException {
        DataDirectories dataDirectories = new DataDirectories(temporaryDirectory.toString());
        dataDirectories.initialize();

        try (Connection connection = DriverManager.getConnection(databaseUrl(dataDirectories))) {
            DSLContext dsl = DSL.using(connection, SQLDialect.SQLITE);

            assertEquals("wal", dsl.fetchValue("PRAGMA journal_mode", String.class));
            assertEquals(2, dsl.fetchValue("PRAGMA synchronous", Integer.class));
            assertEquals(1, dsl.fetchValue("PRAGMA foreign_keys", Integer.class));
        }
    }

    @Test
    void preservesMetadataWhenTheDatabaseIsReopened(@TempDir Path temporaryDirectory)
            throws SQLException {
        DataDirectories dataDirectories = new DataDirectories(temporaryDirectory.toString());
        dataDirectories.initialize();

        String databaseUrl = databaseUrl(dataDirectories);
        Flyway.configure()
                .dataSource(databaseUrl, "", "")
                .table("schema_migrations")
                .locations("classpath:db/migration")
                .load()
                .migrate();

        VaultMetadata first = initialize(databaseUrl);
        VaultMetadata reopened = initialize(databaseUrl);

        assertEquals(first, reopened);
        assertEquals(0, reopened.currentRevision());
    }

    private VaultMetadata initialize(String databaseUrl) throws SQLException {
        try (Connection connection = DriverManager.getConnection(databaseUrl)) {
            DSLContext dsl = DSL.using(connection, SQLDialect.SQLITE);
            return new VaultMetadataRepository(dsl).initialize();
        }
    }

    private String databaseUrl(DataDirectories dataDirectories) {
        return "jdbc:sqlite:file:" + dataDirectories.state().resolve("sync.db")
                + "?journal_mode=WAL&synchronous=FULL&foreign_keys=on";
    }
}
