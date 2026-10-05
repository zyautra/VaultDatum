package io.vaultdatum.server.sync;

import io.quarkus.test.junit.QuarkusTestProfile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class PreMigrationBackupTestProfile implements QuarkusTestProfile {

    static final String VAULT_ID = "V-pre-migration";

    static final Path DATA_ROOT = createDataRoot();

    @Override
    public Map<String, String> getConfigOverrides() {
        return Map.of("vaultdatum.data-root", DATA_ROOT.toString());
    }

    private static Path createDataRoot() {
        try {
            Path root = Files.createTempDirectory("vaultdatum-pre-migration-");
            LegacyDataRoot.create(root, VAULT_ID);
            return root;
        } catch (Exception exception) {
            throw new IllegalStateException("Could not create pre-migration test data", exception);
        }
    }
}
