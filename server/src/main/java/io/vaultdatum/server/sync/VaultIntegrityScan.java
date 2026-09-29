package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.jboss.logging.Logger;
import org.jooq.DSLContext;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Compares the Vault filesystem with the recorded path state and reports drift.
 *
 * <p>The scan only detects and logs. It never changes the journal, the path
 * state, or the Vault filesystem. An unrecorded directory is reported once
 * without descending into it, and symbolic links are never followed.</p>
 */
@ApplicationScoped
public final class VaultIntegrityScan {

    private static final Logger LOG = Logger.getLogger(VaultIntegrityScan.class);

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public VaultIntegrityScan(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public List<Drift> scan() {
        synchronized (MutationLock.INSTANCE) {
            List<Drift> drifts = scanLocked();
            for (Drift drift : drifts) {
                LOG.warnf("external_drift_detected path=%s kind=%s", drift.path(), drift.kind());
            }
            LOG.infof("integrity_scan_complete drifts=%d", drifts.size());
            return drifts;
        }
    }

    private List<Drift> scanLocked() {
        Map<String, Recorded> recorded = recordedPresentEntries();
        Set<String> recordedAncestors = ancestors(recorded.keySet());
        Set<String> seen = new HashSet<>();
        List<Drift> drifts = new ArrayList<>();
        Path vault = dataDirectories.vault();

        try {
            Files.walkFileTree(vault, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) {
                    if (directory.equals(vault)) {
                        return FileVisitResult.CONTINUE;
                    }
                    String path = VaultFiles.relativePath(vault, directory);
                    Recorded entry = recorded.get(path);
                    if (entry != null) {
                        seen.add(path);
                        if (entry instanceof Recorded.File) {
                            drifts.add(new Drift(path, DriftKind.ENTRY_TYPE_MISMATCH));
                            return FileVisitResult.SKIP_SUBTREE;
                        }
                        return FileVisitResult.CONTINUE;
                    }
                    if (recordedAncestors.contains(path)) {
                        return FileVisitResult.CONTINUE;
                    }
                    drifts.add(new Drift(path, DriftKind.UNKNOWN_ENTRY));
                    return FileVisitResult.SKIP_SUBTREE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                    String path = VaultFiles.relativePath(vault, file);
                    Recorded entry = recorded.get(path);
                    if (entry == null) {
                        drifts.add(new Drift(path, DriftKind.UNKNOWN_ENTRY));
                        return FileVisitResult.CONTINUE;
                    }
                    seen.add(path);
                    if (!(entry instanceof Recorded.File recordedFile) || !attributes.isRegularFile()) {
                        drifts.add(new Drift(path, DriftKind.ENTRY_TYPE_MISMATCH));
                    } else if (!recordedFile.matches(file)) {
                        drifts.add(new Drift(path, DriftKind.HASH_MISMATCH));
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException exception) {
                    String path = VaultFiles.relativePath(vault, file);
                    seen.add(path);
                    drifts.add(new Drift(path, DriftKind.UNREADABLE));
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException exception) {
            throw new IllegalStateException("Could not scan the authoritative Vault", exception);
        }

        for (String path : recorded.keySet()) {
            if (!seen.contains(path) && !underUnreadable(path, drifts)) {
                drifts.add(new Drift(path, DriftKind.MISSING));
            }
        }
        drifts.sort((left, right) -> left.path().compareTo(right.path()));
        return drifts;
    }

    private Map<String, Recorded> recordedPresentEntries() {
        Map<String, Recorded> entries = new HashMap<>();
        dsl.select(PATH_STATE.PATH, PATH_STATE.ENTRY_TYPE, PATH_STATE.CONTENT_HASH, PATH_STATE.SIZE)
                .from(PATH_STATE)
                .where(PATH_STATE.STATE.eq("PRESENT"))
                .forEach(record -> entries.put(
                        record.get(PATH_STATE.PATH),
                        "FILE".equals(record.get(PATH_STATE.ENTRY_TYPE))
                                ? new Recorded.File(record.get(PATH_STATE.CONTENT_HASH), record.get(PATH_STATE.SIZE))
                                : Recorded.Directory.INSTANCE));
        return entries;
    }

    private static Set<String> ancestors(Set<String> paths) {
        Set<String> ancestors = new HashSet<>();
        for (String path : paths) {
            String current = path;
            int separator = current.lastIndexOf('/');
            while (separator > 0) {
                current = current.substring(0, separator);
                if (!ancestors.add(current)) {
                    break;
                }
                separator = current.lastIndexOf('/');
            }
        }
        return ancestors;
    }

    private static boolean underUnreadable(String path, List<Drift> drifts) {
        for (Drift drift : drifts) {
            if (drift.kind() == DriftKind.UNREADABLE && path.startsWith(drift.path() + "/")) {
                return true;
            }
        }
        return false;
    }

    public enum DriftKind {
        MISSING,
        HASH_MISMATCH,
        UNKNOWN_ENTRY,
        ENTRY_TYPE_MISMATCH,
        UNREADABLE
    }

    public record Drift(String path, DriftKind kind) {
    }

    private sealed interface Recorded {

        record File(String contentHash, long size) implements Recorded {

            boolean matches(Path file) {
                try {
                    ContentHash.HashedContent actual = ContentHash.calculate(file);
                    return actual.value().equals(contentHash) && actual.size() == size;
                } catch (IOException exception) {
                    return false;
                }
            }
        }

        enum Directory implements Recorded {
            INSTANCE
        }
    }
}
