package io.vaultdatum.server.sync;

import io.quarkus.test.junit.QuarkusTestProfile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class RestoreStartupTestProfile implements QuarkusTestProfile {

    static final String BACKUP_VAULT_ID = "V-before-restore";

    static final Path DATA_ROOT = createDataRoot();

    @Override
    public Map<String, String> getConfigOverrides() {
        return Map.of(
                "vaultdatum.data-root", DATA_ROOT.toString(),
                "vaultdatum.restore-backup", "true");
    }

    private static Path createDataRoot() {
        try {
            Path source = Files.createTempDirectory("vaultdatum-restore-source-");
            LegacyDataRoot.create(source, BACKUP_VAULT_ID);
            Path root = Files.createTempDirectory("vaultdatum-restore-startup-");
            LegacyDataRoot.createBackup(source, root, BACKUP_VAULT_ID);
            Files.createDirectories(root.resolve("vault"));
            Files.writeString(root.resolve("vault/damaged.md"), "Left by a bug", StandardCharsets.UTF_8);
            return root;
        } catch (Exception exception) {
            throw new IllegalStateException("Could not create restore test data", exception);
        }
    }
}
