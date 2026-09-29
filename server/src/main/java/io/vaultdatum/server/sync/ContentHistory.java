package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.HISTORY_OBJECT;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;
import org.jooq.DSLContext;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Keeps the content that MODIFY and DELETE replaced so a single file can be restored later.
 *
 * <p>Objects are stored by content hash outside the Vault and never modified.
 * Keeping history is not required for synchronization correctness: a failure
 * to keep an object is logged and never fails the committed operation.</p>
 */
@ApplicationScoped
public final class ContentHistory {

    private static final Logger LOG = Logger.getLogger(ContentHistory.class);

    private static final Pattern RECOVERY_ARTIFACT = Pattern.compile("(modify|delete)-(.+)\\.bak");

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final Duration retention;

    public ContentHistory(
            DataDirectories dataDirectories,
            DSLContext dsl,
            @ConfigProperty(name = "vaultdatum.history.retention-days", defaultValue = "90") long retentionDays) {
        if (retentionDays < 1) {
            throw new IllegalArgumentException("vaultdatum.history.retention-days must be positive");
        }
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.retention = Duration.ofDays(retentionDays);
    }

    /**
     * Moves a committed operation's recovery artifact into history. Never throws.
     */
    void retain(Path artifact, String expectedHash) {
        try {
            retainOrThrow(artifact, expectedHash);
        } catch (IOException | RuntimeException exception) {
            LOG.warnf("history_retain_failed hash=%s cause=%s", expectedHash, exception.getClass().getSimpleName());
        }
    }

    private void retainOrThrow(Path artifact, String expectedHash) throws IOException {
        if (!Files.isRegularFile(artifact)) {
            return;
        }

        ContentHash.HashedContent actual = ContentHash.calculate(artifact);
        if (!actual.value().equals(expectedHash)) {
            LOG.warnf("history_retain_skipped artifact=%s reason=hash-mismatch", artifact.getFileName());
            return;
        }

        Path object = objectPath(expectedHash);
        Files.createDirectories(object.getParent());
        if (Files.exists(object)) {
            Files.delete(artifact);
        } else {
            Files.move(artifact, object, StandardCopyOption.ATOMIC_MOVE);
            VaultFiles.forceDirectory(object.getParent());
        }
        VaultFiles.forceDirectory(artifact.getParent());

        String storedAt = timestamp(Instant.now());
        dsl.insertInto(HISTORY_OBJECT)
                .columns(HISTORY_OBJECT.CONTENT_HASH, HISTORY_OBJECT.SIZE, HISTORY_OBJECT.STORED_AT)
                .values(expectedHash, actual.size(), storedAt)
                .onConflict(HISTORY_OBJECT.CONTENT_HASH)
                .doUpdate()
                .set(HISTORY_OBJECT.STORED_AT, storedAt)
                .execute();
    }

    /**
     * Returns the stored object for a content hash, or {@code null} if it is not kept.
     */
    Path find(String contentHash) {
        Path object = objectPath(contentHash);
        return Files.isRegularFile(object) ? object : null;
    }

    boolean isKept(String contentHash) {
        return dsl.fetchExists(HISTORY_OBJECT, HISTORY_OBJECT.CONTENT_HASH.eq(contentHash));
    }

    /**
     * Keeps recovery artifacts left behind when the server stopped after a commit but before retaining them.
     */
    public void recoverCommittedArtifacts() {
        synchronized (MutationLock.INSTANCE) {
            List<Path> artifacts;
            try (Stream<Path> entries = Files.list(dataDirectories.recovery())) {
                artifacts = entries.toList();
            } catch (IOException exception) {
                throw new IllegalStateException("Could not list recovery artifacts", exception);
            }

            for (Path artifact : artifacts) {
                Matcher name = RECOVERY_ARTIFACT.matcher(artifact.getFileName().toString());
                if (!name.matches()) {
                    continue;
                }
                String expectedHash = committedBaseHash(name.group(2));
                if (expectedHash != null) {
                    retain(artifact, expectedHash);
                }
            }
        }
    }

    private String committedBaseHash(String operationId) {
        return dsl.select(OPERATION_BASE_CONDITION.EXPECTED_HASH)
                .from(OPERATIONS)
                .join(OPERATION_BASE_CONDITION)
                .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(OPERATIONS.OPERATION_ID))
                .where(OPERATIONS.OPERATION_ID.eq(operationId))
                .and(OPERATIONS.STATUS.eq("COMMITTED"))
                .and(OPERATIONS.OPERATION_TYPE.in("MODIFY", "DELETE"))
                .and(OPERATION_BASE_CONDITION.ORDINAL.eq(0))
                .fetchOne(OPERATION_BASE_CONDITION.EXPECTED_HASH);
    }

    /**
     * Deletes objects kept longer than the retention period. The journal is never changed.
     */
    public int collectExpired() {
        String cutoff = timestamp(Instant.now().minus(retention));
        List<String> expired = dsl.select(HISTORY_OBJECT.CONTENT_HASH)
                .from(HISTORY_OBJECT)
                .where(HISTORY_OBJECT.STORED_AT.lt(cutoff))
                .fetch(HISTORY_OBJECT.CONTENT_HASH);

        for (String contentHash : expired) {
            try {
                Files.deleteIfExists(objectPath(contentHash));
            } catch (IOException exception) {
                LOG.warnf("history_collect_failed hash=%s cause=%s", contentHash, exception.getClass().getSimpleName());
                continue;
            }
            dsl.deleteFrom(HISTORY_OBJECT).where(HISTORY_OBJECT.CONTENT_HASH.eq(contentHash)).execute();
        }

        if (!expired.isEmpty()) {
            LOG.infof("history_collect_complete removed=%d", expired.size());
        }
        return expired.size();
    }

    private Path objectPath(String contentHash) {
        if (!ContentHash.isValid(contentHash)) {
            throw new IllegalArgumentException("Invalid content hash");
        }
        String hex = contentHash.substring("sha256:".length());
        return dataDirectories.history()
                .resolve("objects")
                .resolve("sha256")
                .resolve(hex.substring(0, 2))
                .resolve(hex.substring(2));
    }

    private static String timestamp(Instant instant) {
        return instant.truncatedTo(ChronoUnit.SECONDS).toString();
    }
}
