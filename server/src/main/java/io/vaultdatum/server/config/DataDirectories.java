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
