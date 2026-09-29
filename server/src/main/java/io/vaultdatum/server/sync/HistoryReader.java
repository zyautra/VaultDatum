package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.Condition;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads the change history of one file and the content kept for past revisions.
 */
@ApplicationScoped
public final class HistoryReader {

    public static final int MAXIMUM_PAGE_SIZE = 100;

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final ContentHistory contentHistory;

    public HistoryReader(DataDirectories dataDirectories, DSLContext dsl, ContentHistory contentHistory) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.contentHistory = contentHistory;
    }

    /**
     * Returns the file changes at {@code path}, newest first.
     */
    public HistoryPage read(SyncPath path, Long beforeRevision, int limit) {
        if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
            throw new IllegalArgumentException("The page limit must be between 1 and " + MAXIMUM_PAGE_SIZE);
        }
        if (beforeRevision != null && beforeRevision < 1) {
            throw new IllegalArgumentException("The before cursor must be positive");
        }

        Condition before = beforeRevision == null
                ? DSL.noCondition()
                : CHANGE_EFFECT.REVISION.lt(beforeRevision);
        var records = dsl.select(
                        CHANGE_JOURNAL.REVISION,
                        CHANGE_JOURNAL.CHANGE_TYPE,
                        CHANGE_JOURNAL.COMMITTED_AT,
                        CHANGE_JOURNAL.ACTOR_TYPE,
                        CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                        CHANGE_JOURNAL.SOURCE_PATH,
                        CHANGE_JOURNAL.DESTINATION_PATH,
                        CHANGE_EFFECT.STATE,
                        CHANGE_EFFECT.CONTENT_HASH,
                        CHANGE_EFFECT.SIZE)
                .from(CHANGE_EFFECT)
                .join(CHANGE_JOURNAL).on(CHANGE_JOURNAL.REVISION.eq(CHANGE_EFFECT.REVISION))
                .where(CHANGE_EFFECT.PATH.eq(path.value()))
                .and(CHANGE_EFFECT.ENTRY_TYPE.eq("FILE"))
                .and(before)
                .orderBy(CHANGE_EFFECT.REVISION.desc())
                .limit(limit + 1)
                .fetch();

        boolean hasMore = records.size() > limit;
        List<HistoryEntry> entries = new ArrayList<>(Math.min(records.size(), limit));
        for (var record : hasMore ? records.subList(0, limit) : records) {
            String contentHash = record.get(CHANGE_EFFECT.CONTENT_HASH);
            String type = record.get(CHANGE_JOURNAL.CHANGE_TYPE);
            boolean arrivedByPathChange = ("RENAME".equals(type) || "MOVE".equals(type))
                    && path.value().equals(record.get(CHANGE_JOURNAL.DESTINATION_PATH));
            entries.add(new HistoryEntry(
                    record.get(CHANGE_JOURNAL.REVISION),
                    type,
                    record.get(CHANGE_JOURNAL.COMMITTED_AT),
                    new ChangeReader.ChangeActor(
                            record.get(CHANGE_JOURNAL.ACTOR_TYPE), record.get(CHANGE_JOURNAL.ACTOR_CLIENT_ID)),
                    record.get(CHANGE_EFFECT.STATE),
                    contentHash,
                    record.get(CHANGE_EFFECT.SIZE),
                    contentHash != null && isAvailable(contentHash),
                    arrivedByPathChange ? record.get(CHANGE_JOURNAL.SOURCE_PATH) : null));
        }
        return new HistoryPage(path.value(), entries, hasMore);
    }

    /**
     * Returns verified content for a hash from history or from a current Vault file.
     *
     * @throws ContentNotRetainedException if no verified copy exists
     */
    public Content readContent(String contentHash) {
        if (!ContentHash.isValid(contentHash)) {
            throw new IllegalArgumentException("The content hash is invalid");
        }

        Path kept = contentHistory.find(contentHash);
        if (kept != null && VaultFiles.hasContent(kept, contentHash)) {
            return new Content(kept);
        }
        for (String candidate : currentPathsWith(contentHash)) {
            Path file = SyncPath.parse(candidate).resolveUnder(dataDirectories.vault());
            if (VaultFiles.hasContent(file, contentHash)) {
                return new Content(file);
            }
        }
        throw new ContentNotRetainedException(contentHash);
    }

    private boolean isAvailable(String contentHash) {
        return contentHistory.isKept(contentHash) || !currentPathsWith(contentHash).isEmpty();
    }

    private List<String> currentPathsWith(String contentHash) {
        return dsl.select(PATH_STATE.PATH)
                .from(PATH_STATE)
                .where(PATH_STATE.CONTENT_HASH.eq(contentHash))
                .and(PATH_STATE.ENTRY_TYPE.eq("FILE"))
                .and(PATH_STATE.STATE.eq("PRESENT"))
                .fetch(PATH_STATE.PATH);
    }

    public record HistoryPage(String path, List<HistoryEntry> entries, boolean hasMore) {
    }

    public record HistoryEntry(
            long revision,
            String type,
            String committedAt,
            ChangeReader.ChangeActor actor,
            String state,
            String contentHash,
            Long size,
            boolean contentAvailable,
            String previousPath) {
    }

    public record Content(Path path) {
    }
}
