package io.vaultdatum.server.api;

import io.quarkus.test.junit.QuarkusTestProfile;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class PublicTokenTestProfile implements QuarkusTestProfile {

    public static final String VAULT_TOKEN = "vd1_" + "A".repeat(43);

    private static final Path TOKEN_FILE = createTokenFile();

    @Override
    public Map<String, String> getConfigOverrides() {
        return Map.of(
                "vaultdatum.access-profile", "public-token",
                "vaultdatum.auth.token-file", TOKEN_FILE.toString());
    }

    private static Path createTokenFile() {
        try {
            Path tokenFile = Files.createTempFile("vaultdatum-public-token-", ".txt");
            Files.writeString(tokenFile, VAULT_TOKEN + "\n", StandardCharsets.UTF_8);
            tokenFile.toFile().deleteOnExit();
            return tokenFile;
        } catch (IOException exception) {
            throw new IllegalStateException("Could not create public token test file", exception);
        }
    }
}
