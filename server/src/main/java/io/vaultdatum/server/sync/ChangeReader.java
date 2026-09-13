package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;

import io.vaultdatum.server.persistence.VaultMetadata;
import io.vaultdatum.server.persistence.VaultMetadataRepository;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.util.ArrayList;
import java.util.List;

@ApplicationScoped
public final class ChangeReader {

    public static final int MAXIMUM_PAGE_SIZE = 500;

    private final DSLContext dsl;

    private final VaultMetadataRepository vaultMetadataRepository;

    public ChangeReader(DSLContext dsl, VaultMetadataRepository vaultMetadataRepository) {
        this.dsl = dsl;
        this.vaultMetadataRepository = vaultMetadataRepository;
    }

    public ChangePage read(long afterRevision, int limit) {
        if (afterRevision < 0) {
            throw new IllegalArgumentException("The after cursor must not be negative");
        }
        if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
            throw new IllegalArgumentException("The page limit must be between 1 and " + MAXIMUM_PAGE_SIZE);
        }

        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            VaultMetadata metadata = vaultMetadataRepository.current(transaction);

            if (afterRevision > metadata.currentRevision()) {
                throw new IllegalArgumentException("The after cursor is ahead of the server revision");
            }

            var journal = transaction.select(
                            CHANGE_JOURNAL.REVISION,
                            CHANGE_JOURNAL.CHANGE_TYPE,
                            CHANGE_JOURNAL.OPERATION_ID,
                            CHANGE_JOURNAL.ACTOR_TYPE,
                            CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                            CHANGE_JOURNAL.SOURCE_PATH,
                            CHANGE_JOURNAL.DESTINATION_PATH)
                    .from(CHANGE_JOURNAL)
                    .where(CHANGE_JOURNAL.REVISION.gt(afterRevision))
                    .orderBy(CHANGE_JOURNAL.REVISION.asc())
                    .limit(limit + 1)
                    .fetch();
            boolean hasMore = journal.size() > limit;
            var pageJournal = hasMore ? journal.subList(0, limit) : journal;
            List<Change> changes = new ArrayList<>(pageJournal.size());

            for (var change : pageJournal) {
                List<ChangeEffect> effects = transaction.select(
                                CHANGE_EFFECT.PATH,
                                CHANGE_EFFECT.ENTRY_TYPE,
                                CHANGE_EFFECT.STATE,
                                CHANGE_EFFECT.CONTENT_HASH,
                                CHANGE_EFFECT.SIZE)
                        .from(CHANGE_EFFECT)
                        .where(CHANGE_EFFECT.REVISION.eq(change.get(CHANGE_JOURNAL.REVISION)))
                        .orderBy(CHANGE_EFFECT.ORDINAL.asc())
                        .fetch(record -> new ChangeEffect(
                                record.get(CHANGE_EFFECT.PATH),
                                record.get(CHANGE_EFFECT.ENTRY_TYPE),
                                record.get(CHANGE_EFFECT.STATE),
                                record.get(CHANGE_EFFECT.CONTENT_HASH),
                                record.get(CHANGE_EFFECT.SIZE)));
                changes.add(new Change(
                        change.get(CHANGE_JOURNAL.REVISION),
                        change.get(CHANGE_JOURNAL.CHANGE_TYPE),
                        change.get(CHANGE_JOURNAL.OPERATION_ID),
                        new ChangeActor(
                                change.get(CHANGE_JOURNAL.ACTOR_TYPE),
                                change.get(CHANGE_JOURNAL.ACTOR_CLIENT_ID)),
                        change.get(CHANGE_JOURNAL.SOURCE_PATH),
                        change.get(CHANGE_JOURNAL.DESTINATION_PATH),
                        effects));
            }

            long toInclusive = changes.isEmpty() ? afterRevision : changes.getLast().revision();
            return new ChangePage(
                    metadata.vaultId(),
                    afterRevision,
                    toInclusive,
                    metadata.currentRevision(),
                    hasMore,
                    changes);
        });
    }

    public record ChangePage(
            String vaultId,
            long fromExclusive,
            long toInclusive,
            long currentRevision,
            boolean hasMore,
            List<Change> changes) {
    }

    public record Change(
            long revision,
            String type,
            String operationId,
            ChangeActor actor,
            String sourcePath,
            String destinationPath,
            List<ChangeEffect> effects) {
    }

    public record ChangeActor(String type, String clientId) {
    }

    public record ChangeEffect(String path, String entryType, String state, String contentHash, Long size) {
    }
}
