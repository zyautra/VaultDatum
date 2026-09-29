package io.vaultdatum.server.sync;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.vaultdatum.server.sync.InitialVaultImport.Entry;
import io.vaultdatum.server.sync.InitialVaultImport.EntryType;
import io.vaultdatum.server.sync.InitialVaultImport.Preflight;
import io.vaultdatum.server.sync.InitialVaultImport.Problem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

class InitialVaultImportPreflightTest {

    @TempDir
    Path vault;

    @Test
    void acceptsRegularFilesAndEmptyDirectories() throws IOException {
        Files.createDirectories(vault.resolve("notes/empty"));
        Files.writeString(vault.resolve("notes/a.md"), "A", StandardCharsets.UTF_8);

        Preflight preflight = InitialVaultImport.preflight(vault, 10);

        assertEquals(List.of(
                new Entry("notes/a.md", EntryType.FILE),
                new Entry("notes/empty", EntryType.DIRECTORY)), preflight.entries());
        assertEquals(List.of(), preflight.problems());
    }

    @Test
    void reportsEveryEntryThatBlocksTheImport() throws IOException {
        Files.createDirectories(vault.resolve(".obsidian/plugins"));
        Files.writeString(vault.resolve(".obsidian/app.json"), "{}", StandardCharsets.UTF_8);
        Files.createDirectories(vault.resolve("project/.git"));
        Files.writeString(vault.resolve("project/.gitignore"), "build/", StandardCharsets.UTF_8);
        Files.writeString(vault.resolve("project/large.pdf"), "12345678901", StandardCharsets.UTF_8);
        Files.writeString(vault.resolve("project/note.md"), "Note", StandardCharsets.UTF_8);
        Files.createSymbolicLink(vault.resolve("project/linked.md"), vault.resolve("project/note.md"));

        Preflight preflight = InitialVaultImport.preflight(vault, 10);

        assertEquals(List.of(
                new Problem(".obsidian", "hidden entry"),
                new Problem("project/.git", "hidden entry"),
                new Problem("project/.gitignore", "hidden entry"),
                new Problem("project/large.pdf", "exceeds the maximum content size"),
                new Problem("project/linked.md", "not a regular file")), preflight.problems());
    }
}
