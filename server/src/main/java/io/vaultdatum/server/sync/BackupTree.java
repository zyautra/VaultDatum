package io.vaultdatum.server.sync;

import org.jboss.logging.Logger;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;

/**
 * Filesystem rules for the server Backup.
 *
 * <p>The server never rewrites a Vault file, history object, recovery
 * artifact, or staged upload in place: every change creates a new file and
 * moves it atomically. A hard link therefore preserves the linked content
 * after the original path changes, so a Backup links files instead of copying
 * them. The SQLite database is rewritten in place and must never be linked.</p>
 */
final class BackupTree {

    private static final Logger LOG = Logger.getLogger(BackupTree.class);

    private BackupTree() {
    }

    record Totals(long files, long bytes) {
    }

    /**
     * Recreates the directories of {@code source} under {@code target} and links its regular files.
     *
     * <p>A file that cannot be linked is copied. Entries other than regular
     * files and directories are skipped and logged.</p>
     */
    static Totals link(Path source, Path target) throws IOException {
        Files.createDirectories(target);
        if (!Files.isDirectory(source)) {
            return new Totals(0, 0);
        }

        long[] totals = new long[2];
        Files.walkFileTree(source, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                    throws IOException {
                Files.createDirectories(target.resolve(source.relativize(directory)));
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                if (!attributes.isRegularFile()) {
                    LOG.warnf("backup_entry_skipped path=%s reason=unsupported-entry-type",
                            VaultFiles.relativePath(source, file));
                    return FileVisitResult.CONTINUE;
                }
                linkOrCopy(file, target.resolve(source.relativize(file)));
                totals[0]++;
                totals[1] += attributes.size();
                return FileVisitResult.CONTINUE;
            }
        });
        return new Totals(totals[0], totals[1]);
    }

    /**
     * Counts the regular files below {@code root} and their total size.
     */
    static Totals count(Path root) throws IOException {
        if (!Files.isDirectory(root)) {
            return new Totals(0, 0);
        }

        long[] totals = new long[2];
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                if (attributes.isRegularFile()) {
                    totals[0]++;
                    totals[1] += attributes.size();
                }
                return FileVisitResult.CONTINUE;
            }
        });
        return new Totals(totals[0], totals[1]);
    }

    /**
     * Deletes {@code root} and everything below it without following symbolic links.
     */
    static void delete(Path root) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }

        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException exception) throws IOException {
                if (exception != null) {
                    throw exception;
                }
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void linkOrCopy(Path source, Path target) throws IOException {
        try {
            Files.createLink(target, source);
        } catch (FileAlreadyExistsException exception) {
            throw exception;
        } catch (UnsupportedOperationException | FileSystemException exception) {
            Files.copy(source, target, StandardCopyOption.COPY_ATTRIBUTES);
        }
    }
}
