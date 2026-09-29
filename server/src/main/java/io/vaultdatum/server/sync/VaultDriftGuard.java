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

/**
 * Verifies, before a mutation is prepared, that the Vault filesystem matches the recorded path state.
 *
 * <p>The server Vault is modified only through the Sync API. A direct filesystem
 * edit is drift: it is neither imported nor overwritten. Checking before the
 * prepared record keeps drift from producing an operation that recovery cannot
 * finish. Callers must hold {@link MutationLock#INSTANCE}.</p>
 */
@ApplicationScoped
final class VaultDriftGuard {

    private static final Logger LOG = Logger.getLogger(VaultDriftGuard.class);

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    VaultDriftGuard(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    /**
     * Requires a recorded present file to exist on disk with its recorded hash and size.
     *
     * <p>Paths that are not recorded as present files are left to the base validation.</p>
     */
    void requireRecordedFile(SyncPath path) {
        requireLocked();
        var state = dsl.select(PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.CONTENT_HASH, PATH_STATE.SIZE)
                .from(PATH_STATE)
                .where(PATH_STATE.PATH.eq(path.value()))
                .fetchOne();

        if (state == null || !"FILE".equals(state.get(PATH_STATE.ENTRY_TYPE))
                || !"PRESENT".equals(state.get(PATH_STATE.STATE))) {
            return;
        }

        Path target = path.resolveUnder(dataDirectories.vault());
        try {
            if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
                throw drift(path, "missing");
            }
            ContentHash.HashedContent actual = ContentHash.calculate(target);
            if (!actual.value().equals(state.get(PATH_STATE.CONTENT_HASH))
                    || actual.size() != state.get(PATH_STATE.SIZE)) {
                throw drift(path, "hash-mismatch");
            }
        } catch (IOException exception) {
            LOG.warnf("external_drift_detected path=%s kind=unreadable", path.value());
            throw new VaultDriftException(path.value(), exception);
        }
    }

    /**
     * Requires a path that is not recorded as present to be absent from disk.
     */
    void requireUnrecordedPathAbsent(SyncPath path) {
        requireLocked();
        boolean recordedPresent = dsl.fetchExists(dsl.selectOne()
                .from(PATH_STATE)
                .where(PATH_STATE.PATH.eq(path.value()))
                .and(PATH_STATE.STATE.eq("PRESENT")));

        if (!recordedPresent && Files.exists(path.resolveUnder(dataDirectories.vault()), LinkOption.NOFOLLOW_LINKS)) {
            throw drift(path, "unknown-entry");
        }
    }

    private static VaultDriftException drift(SyncPath path, String kind) {
        LOG.warnf("external_drift_detected path=%s kind=%s", path.value(), kind);
        return new VaultDriftException(path.value());
    }

    private static void requireLocked() {
        if (!Thread.holdsLock(MutationLock.INSTANCE)) {
            throw new IllegalStateException("Vault drift must be checked while holding the mutation lock");
        }
    }
}
