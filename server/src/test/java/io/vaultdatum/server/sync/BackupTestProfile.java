package io.vaultdatum.server.sync;

import io.quarkus.test.junit.QuarkusTestProfile;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class BackupTestProfile implements QuarkusTestProfile {

    static final Path DATA_ROOT = createDataRoot();

    @Override
    public Map<String, String> getConfigOverrides() {
        return Map.of("vaultdatum.data-root", DATA_ROOT.toString());
    }

    private static Path createDataRoot() {
        try {
            return Files.createTempDirectory("vaultdatum-backup-");
        } catch (IOException exception) {
            throw new IllegalStateException("Could not create backup test data", exception);
        }
    }
}
