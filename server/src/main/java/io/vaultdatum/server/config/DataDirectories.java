package io.vaultdatum.server.config;

import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

@ApplicationScoped
public final class DataDirectories {

    private final Path root;

    public DataDirectories(@ConfigProperty(name = "vaultdatum.data-root") String dataRoot) {
        root = Path.of(dataRoot).toAbsolutePath().normalize();
    }

    public void initialize() {
        createDirectory(root);
        createDirectory(vault());
        createDirectory(state());
        createDirectory(sqliteTemporary());
        createDirectory(staging());
        createDirectory(recovery());
    }

    public Path root() {
        return root;
    }

    public Path vault() {
        return root.resolve("vault");
    }

    public Path state() {
        return root.resolve("state");
    }

    public Path staging() {
        return root.resolve("staging");
    }

    public Path sqliteTemporary() {
        return state().resolve(".sqlite-tmp");
    }

    public Path recovery() {
        return root.resolve("recovery");
    }

    /**
     * Resolves a staging reference recorded in operation metadata.
     */
    public Path stagedFile(String reference) {
        if (reference == null || reference.isBlank()) {
            throw new IllegalStateException("Missing staging reference in operation metadata");
        }

        Path staged = staging().resolve(reference).normalize();
        if (!staging().equals(staged.getParent())) {
            throw new IllegalStateException("Invalid staging reference in operation metadata");
        }
        return staged;
    }

    /**
     * Requires uploaded content to be a regular file directly under the staging directory.
     */
    public Path requireStagedFile(Path content) {
        Path normalized = content.toAbsolutePath().normalize();

        if (!staging().equals(normalized.getParent()) || !Files.isRegularFile(normalized)) {
            throw new IllegalArgumentException("Content must be staged under the server staging directory");
        }
        return normalized;
    }

    private void createDirectory(Path directory) {
        try {
            Files.createDirectories(directory);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not create server data directory: " + directory, exception);
        }

        if (!Files.isDirectory(directory)) {
            throw new IllegalStateException("Server data path is not a directory: " + directory);
        }
    }
}
