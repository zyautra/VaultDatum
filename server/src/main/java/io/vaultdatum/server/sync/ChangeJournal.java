package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import org.jooq.DSLContext;

import java.time.Instant;

/**
 * Appends committed changes and their path effects inside a caller's transaction.
 */
final class ChangeJournal {

    private ChangeJournal() {
    }

    /**
     * Reserves the next global revision.
     */
    static long nextRevision(DSLContext transaction) {
        long revision = transaction.select(VAULT_METADATA.CURRENT_REVISION)
                .from(VAULT_METADATA)
                .where(VAULT_METADATA.ID.eq(1))
                .fetchSingle(VAULT_METADATA.CURRENT_REVISION) + 1;
        transaction.update(VAULT_METADATA)
                .set(VAULT_METADATA.CURRENT_REVISION, revision)
                .where(VAULT_METADATA.ID.eq(1))
                .execute();
        return revision;
    }

    static void appendClientChange(
            DSLContext transaction,
            long revision,
            String operationId,
            String changeType,
            String clientId,
            String sourcePath,
            String destinationPath) {
        appendChange(transaction, revision, operationId, changeType, "CLIENT", clientId, sourcePath, destinationPath);
    }

    static void appendServerExternalChange(DSLContext transaction, long revision, String operationId, String changeType) {
        appendChange(transaction, revision, operationId, changeType, "SERVER_EXTERNAL", null, null, null);
    }

    static void appendPresentFile(
            DSLContext transaction, long revision, int ordinal, String path, String contentHash, long size) {
        appendEffect(transaction, revision, ordinal, path, "FILE", "PRESENT", contentHash, size);
    }

    static void appendPresentDirectory(DSLContext transaction, long revision, int ordinal, String path) {
        appendEffect(transaction, revision, ordinal, path, "DIRECTORY", "PRESENT", null, null);
    }

    static void appendDeleted(DSLContext transaction, long revision, int ordinal, String path, String entryType) {
        appendEffect(transaction, revision, ordinal, path, entryType, "DELETED", null, null);
    }

    private static void appendChange(
            DSLContext transaction,
            long revision,
            String operationId,
            String changeType,
            String actorType,
            String clientId,
            String sourcePath,
            String destinationPath) {
        transaction.insertInto(CHANGE_JOURNAL)
                .columns(
                        CHANGE_JOURNAL.REVISION,
                        CHANGE_JOURNAL.OPERATION_ID,
                        CHANGE_JOURNAL.CHANGE_TYPE,
                        CHANGE_JOURNAL.ACTOR_TYPE,
                        CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                        CHANGE_JOURNAL.SOURCE_PATH,
                        CHANGE_JOURNAL.DESTINATION_PATH,
                        CHANGE_JOURNAL.COMMITTED_AT)
                .values(
                        revision,
                        operationId,
                        changeType,
                        actorType,
                        clientId,
                        sourcePath,
                        destinationPath,
                        Instant.now().toString())
                .execute();
    }

    private static void appendEffect(
            DSLContext transaction,
            long revision,
            int ordinal,
            String path,
            String entryType,
            String state,
            String contentHash,
            Long size) {
        transaction.insertInto(CHANGE_EFFECT)
                .columns(
                        CHANGE_EFFECT.REVISION,
                        CHANGE_EFFECT.ORDINAL,
                        CHANGE_EFFECT.PATH,
                        CHANGE_EFFECT.ENTRY_TYPE,
                        CHANGE_EFFECT.STATE,
                        CHANGE_EFFECT.CONTENT_HASH,
                        CHANGE_EFFECT.SIZE)
                .values(revision, ordinal, path, entryType, state, contentHash, size)
                .execute();
    }
}
