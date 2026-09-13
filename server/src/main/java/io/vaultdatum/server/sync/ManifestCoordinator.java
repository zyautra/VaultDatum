package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.MANIFEST;
import static io.vaultdatum.server.jooq.Tables.MANIFEST_ENTRY;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@ApplicationScoped
public final class ManifestCoordinator {

    private static final Duration LIFETIME = Duration.ofMinutes(15);

    private final DSLContext dsl;

    public ManifestCoordinator(DSLContext dsl) {
        this.dsl = dsl;
    }

    public Created create() {
        synchronized (MutationLock.INSTANCE) {
            return dsl.transactionResult(configuration -> {
                DSLContext transaction = DSL.using(configuration);
                Instant now = Instant.now();
                Instant expiresAt = now.plus(LIFETIME);
                var metadata = transaction.select(VAULT_METADATA.VAULT_ID, VAULT_METADATA.CURRENT_REVISION)
                        .from(VAULT_METADATA)
                        .where(VAULT_METADATA.ID.eq(1))
                        .fetchSingle();
                String manifestId = "M-" + UUID.randomUUID();

                transaction.deleteFrom(MANIFEST)
                        .where(MANIFEST.EXPIRES_AT.lt(now.toString()))
                        .execute();
                transaction.insertInto(MANIFEST)
                        .columns(
                                MANIFEST.MANIFEST_ID,
                                MANIFEST.VAULT_ID,
                                MANIFEST.SNAPSHOT_REVISION,
                                MANIFEST.EXPIRES_AT)
                        .values(
                                manifestId,
                                metadata.get(VAULT_METADATA.VAULT_ID),
                                metadata.get(VAULT_METADATA.CURRENT_REVISION),
                                expiresAt.toString())
                        .execute();

                for (var entry : transaction.select(
                                PATH_STATE.PATH,
                                PATH_STATE.ENTRY_TYPE,
                                PATH_STATE.STATE,
                                PATH_STATE.LATEST_REVISION,
                                PATH_STATE.CONTENT_HASH,
                                PATH_STATE.SIZE)
                        .from(PATH_STATE)
                        .orderBy(PATH_STATE.PATH.asc())
                        .fetch()) {
                    transaction.insertInto(MANIFEST_ENTRY)
                            .columns(
                                    MANIFEST_ENTRY.MANIFEST_ID,
                                    MANIFEST_ENTRY.PATH,
                                    MANIFEST_ENTRY.ENTRY_TYPE,
                                    MANIFEST_ENTRY.STATE,
                                    MANIFEST_ENTRY.LATEST_REVISION,
                                    MANIFEST_ENTRY.CONTENT_HASH,
                                    MANIFEST_ENTRY.SIZE)
                            .values(
                                    manifestId,
                                    entry.get(PATH_STATE.PATH),
                                    entry.get(PATH_STATE.ENTRY_TYPE),
                                    entry.get(PATH_STATE.STATE),
                                    entry.get(PATH_STATE.LATEST_REVISION),
                                    entry.get(PATH_STATE.CONTENT_HASH),
                                    entry.get(PATH_STATE.SIZE))
                            .execute();
                }
                return new Created(
                        manifestId,
                        metadata.get(VAULT_METADATA.VAULT_ID),
                        metadata.get(VAULT_METADATA.CURRENT_REVISION),
                        expiresAt.toString());
            });
        }
    }

    public Snapshot read(String manifestId) {
        if (manifestId == null || manifestId.isBlank()) {
            throw new IllegalArgumentException("The manifest ID is required");
        }

        var manifest = dsl.select(
                        MANIFEST.VAULT_ID,
                        MANIFEST.SNAPSHOT_REVISION,
                        MANIFEST.EXPIRES_AT)
                .from(MANIFEST)
                .where(MANIFEST.MANIFEST_ID.eq(manifestId))
                .fetchOne();
        if (manifest == null) {
            throw new ManifestNotFoundException(manifestId);
        }

        String expiresAt = manifest.get(MANIFEST.EXPIRES_AT);
        if (expired(expiresAt)) {
            dsl.deleteFrom(MANIFEST).where(MANIFEST.MANIFEST_ID.eq(manifestId)).execute();
            throw new ManifestExpiredException(manifestId);
        }

        List<Entry> entries = dsl.select(
                        MANIFEST_ENTRY.PATH,
                        MANIFEST_ENTRY.ENTRY_TYPE,
                        MANIFEST_ENTRY.STATE,
                        MANIFEST_ENTRY.LATEST_REVISION,
                        MANIFEST_ENTRY.CONTENT_HASH,
                        MANIFEST_ENTRY.SIZE)
                .from(MANIFEST_ENTRY)
                .where(MANIFEST_ENTRY.MANIFEST_ID.eq(manifestId))
                .orderBy(MANIFEST_ENTRY.PATH.asc())
                .fetch(entry -> new Entry(
                        entry.get(MANIFEST_ENTRY.PATH),
                        entry.get(MANIFEST_ENTRY.ENTRY_TYPE),
                        entry.get(MANIFEST_ENTRY.STATE),
                        entry.get(MANIFEST_ENTRY.LATEST_REVISION),
                        entry.get(MANIFEST_ENTRY.CONTENT_HASH),
                        entry.get(MANIFEST_ENTRY.SIZE)));
        return new Snapshot(
                manifestId,
                manifest.get(MANIFEST.VAULT_ID),
                manifest.get(MANIFEST.SNAPSHOT_REVISION),
                expiresAt,
                entries);
    }

    private static boolean expired(String expiresAt) {
        try {
            return !Instant.parse(expiresAt).isAfter(Instant.now());
        } catch (RuntimeException exception) {
            throw new IllegalStateException("Manifest expiry is invalid", exception);
        }
    }

    public record Created(String manifestId, String vaultId, long snapshotRevision, String expiresAt) {
    }

    public record Snapshot(
            String manifestId,
            String vaultId,
            long snapshotRevision,
            String expiresAt,
            List<Entry> entries) {
    }

    public record Entry(
            String path,
            String entryType,
            String state,
            long revision,
            String contentHash,
            Long size) {
    }
}
