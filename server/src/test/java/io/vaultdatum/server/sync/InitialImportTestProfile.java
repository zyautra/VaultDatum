package io.vaultdatum.server.sync;

import io.quarkus.test.junit.QuarkusTestProfile;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class InitialImportTestProfile implements QuarkusTestProfile {

    static final Path DATA_ROOT = createMigratedDataRoot();

    @Override
    public Map<String, String> getConfigOverrides() {
        return Map.of(
                "vaultdatum.data-root", DATA_ROOT.toString(),
                "vaultdatum.initial-import", "true");
    }

    private static Path createMigratedDataRoot() {
        try {
            Path root = Files.createTempDirectory("vaultdatum-initial-import-");
            Path vault = root.resolve("vault");
            Files.createDirectories(vault.resolve("notes/nested"));
            Files.createDirectories(vault.resolve("attachments/empty"));
            Files.writeString(vault.resolve("notes/first.md"), "First note", StandardCharsets.UTF_8);
            Files.writeString(vault.resolve("notes/nested/second.md"), "Second note", StandardCharsets.UTF_8);
            Files.write(vault.resolve("attachments/image.png"), new byte[] {1, 2, 3});
            return root;
        } catch (IOException exception) {
            throw new IllegalStateException("Could not create initial import test data", exception);
        }
    }
}
