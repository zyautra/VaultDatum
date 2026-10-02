package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.jboss.logging.Logger;
import org.jooq.DSLContext;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * Removes Vault directories that existed only as parents of removed entries.
 *
 * <p>A directory recorded in path state is a synchronized entry and is never
 * removed here. Any other directory exists only because it contained a
 * synchronized entry. Once the last entry is deleted or moved away, such an
 * empty parent is removed so that a later directory CREATE at the same path
 * does not find an unrecorded directory. A directory that contains anything,
 * including hidden files, is kept. Removing parents is not required for
 * synchronization correctness: a failure is logged and never fails the
 * committed operation.</p>
 */
@ApplicationScoped
public final class ImplicitParentDirectories {

    private static final Logger LOG = Logger.getLogger(ImplicitParentDirectories.class);

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public ImplicitParentDirectories(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    /**
     * Removes the empty implicit parents of a path that was just deleted or moved away.
     */
    void pruneAbove(SyncPath removedPath) {
        if (!Thread.holdsLock(MutationLock.INSTANCE)) {
            throw new IllegalStateException("Implicit parents must be pruned while holding the mutation lock");
        }

        String parent = parentOf(removedPath.value());
        while (parent != null && pruneIfEmptyAndImplicit(parent)) {
            parent = parentOf(parent);
        }
    }

    /**
     * Removes empty implicit parents that earlier server versions left behind.
     *
     * <p>Only ancestors of recorded deleted entries are considered, so an
     * empty directory created outside the Sync API stays in place and is
     * reported as drift.</p>
     */
    public void pruneLeftovers() {
        synchronized (MutationLock.INSTANCE) {
            List<String> deletedPaths = dsl.select(PATH_STATE.PATH)
                    .from(PATH_STATE)
                    .where(PATH_STATE.STATE.eq("DELETED"))
                    .fetch(PATH_STATE.PATH);
            Set<String> candidates = new TreeSet<>(Comparator.comparingInt(ImplicitParentDirectories::depth)
                    .reversed()
                    .thenComparing(Comparator.naturalOrder()));
            for (String deleted : deletedPaths) {
                for (String ancestor = parentOf(deleted); ancestor != null; ancestor = parentOf(ancestor)) {
                    candidates.add(ancestor);
                }
            }

            int removed = 0;
            for (String candidate : candidates) {
                if (pruneIfEmptyAndImplicit(candidate)) {
                    removed++;
                }
            }
            if (removed > 0) {
                LOG.infof("implicit_parent_cleanup_complete removed=%d", removed);
            }
        }
    }

    private boolean pruneIfEmptyAndImplicit(String path) {
        if (isRecordedDirectory(path)) {
            return false;
        }

        Path directory = SyncPath.parse(path).resolveUnder(dataDirectories.vault());
        try {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) || !VaultFiles.isEmptyDirectory(directory)) {
                return false;
            }
            Files.delete(directory);
            VaultFiles.forceDirectory(directory.getParent());
            return true;
        } catch (IOException | RuntimeException exception) {
            LOG.warnf("implicit_parent_cleanup_failed path=%s cause=%s", path, exception.getClass().getSimpleName());
            return false;
        }
    }

    private boolean isRecordedDirectory(String path) {
        return dsl.fetchExists(dsl.selectOne()
                .from(PATH_STATE)
                .where(PATH_STATE.PATH.eq(path))
                .and(PATH_STATE.ENTRY_TYPE.eq("DIRECTORY"))
                .and(PATH_STATE.STATE.eq("PRESENT")));
    }

    private static String parentOf(String path) {
        int separator = path.lastIndexOf('/');
        return separator > 0 ? path.substring(0, separator) : null;
    }

    private static int depth(String path) {
        return (int) path.chars().filter(character -> character == '/').count();
    }
}
