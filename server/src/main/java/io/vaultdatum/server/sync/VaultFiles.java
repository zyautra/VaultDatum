package io.vaultdatum.server.sync;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;

/**
 * Filesystem rules shared by Vault mutations, recovery, and scans.
 */
final class VaultFiles {

    private VaultFiles() {
    }

    /**
     * Flushes a directory entry change to durable storage.
     */
    static void forceDirectory(Path directory) {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not durably update directory: " + directory, exception);
        }
    }

    /**
     * Flushes {@code directory} and each parent up to and including {@code root}.
     */
    static void forceDirectoriesUpTo(Path directory, Path root) {
        Path current = directory;

        while (true) {
            forceDirectory(current);
            if (current.equals(root)) {
                return;
            }
            current = current.getParent();
        }
    }

    /**
     * Returns whether {@code file} is a regular file with the expected hash.
     */
    static boolean hasContent(Path file, String expectedHash) {
        return hasContent(file, expectedHash, -1);
    }

    /**
     * Returns whether {@code file} is a regular file with the expected hash and, unless negative, size.
     */
    static boolean hasContent(Path file, String expectedHash, long expectedSize) {
        if (!Files.isRegularFile(file)) {
            return false;
        }

        try {
            ContentHash.HashedContent actual = ContentHash.calculate(file);
            return expectedHash.equals(actual.value()) && (expectedSize < 0 || expectedSize == actual.size());
        } catch (IOException exception) {
            throw new IllegalStateException("Could not hash an authoritative file", exception);
        }
    }

    static boolean isEmptyDirectory(Path directory) throws IOException {
        try (var entries = Files.list(directory)) {
            return entries.findAny().isEmpty();
        }
    }

    /**
     * Returns the forward-slash path of {@code file} relative to {@code root}.
     */
    static String relativePath(Path root, Path file) {
        List<String> segments = new ArrayList<>();
        for (Path segment : root.relativize(file)) {
            segments.add(segment.toString());
        }
        return String.join("/", segments);
    }
}
