package io.vaultdatum.server.sync;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

class SyncPathTest {

    @Test
    void acceptsVaultRelativePath() {
        assertEquals("notes/first.md", SyncPath.parse("notes/first.md").value());
    }

    @Test
    void rejectsUnsafeOrExcludedPaths() {
        assertThrows(IllegalArgumentException.class, () -> SyncPath.parse("../outside.md"));
        assertThrows(IllegalArgumentException.class, () -> SyncPath.parse("/absolute.md"));
        assertThrows(IllegalArgumentException.class, () -> SyncPath.parse(".obsidian/plugins/x"));
        assertThrows(IllegalArgumentException.class, () -> SyncPath.parse("notes\\windows.md"));
    }

    @Test
    void resolvesOnlyBelowVaultRoot(@TempDir Path temporaryDirectory) {
        Path vaultRoot = temporaryDirectory.resolve("vault");

        assertEquals(vaultRoot.resolve("notes/first.md"),
                SyncPath.parse("notes/first.md").resolveUnder(vaultRoot));
    }

    @Test
    void copiesAndHashesContentWithoutKeepingItInMemory(@TempDir Path temporaryDirectory) throws Exception {
        Path source = temporaryDirectory.resolve("source.md");
        Path destination = temporaryDirectory.resolve("destination.md");
        Files.writeString(source, "VaultDatum", StandardCharsets.UTF_8);

        ContentHash.HashedContent copied = ContentHash.copy(source, destination);

        assertEquals("sha256:c4c18008dcfb575c1f46d597421df7b7f1a30d7b3f55b0326b7070ae7728f116",
                copied.value());
        assertEquals(10, copied.size());
        assertEquals("VaultDatum", Files.readString(destination, StandardCharsets.UTF_8));
    }
}
