package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;

import org.jooq.DSLContext;

import java.time.Instant;

/**
 * Durable client operation records: idempotent replay, prepared intent, and commit marking.
 */
final class OperationRecords {

    private OperationRecords() {
    }

    /**
     * Returns the committed result of a retried operation, or {@code null} for a new operation ID.
     *
     * @throws OperationIdReuseException if the ID was recorded for a different request
     * @throws RecoveryRequiredException if the recorded operation is not committed yet
     */
    static OperationResult replay(DSLContext dsl, String operationId, String requestDigest) {
        var record = dsl.select(OPERATIONS.STATUS, OPERATIONS.RESULT_REVISION, OPERATIONS.REQUEST_DIGEST)
                .from(OPERATIONS)
                .where(OPERATIONS.OPERATION_ID.eq(operationId))
                .fetchOne();

        if (record == null) {
            return null;
        }
        requireMatchingDigest(operationId, requestDigest, record.get(OPERATIONS.REQUEST_DIGEST));
        if (!"COMMITTED".equals(record.get(OPERATIONS.STATUS))) {
            throw new RecoveryRequiredException(operationId);
        }
        return new OperationResult(operationId, record.get(OPERATIONS.RESULT_REVISION), true);
    }

    static void requireMatchingDigest(String operationId, String requestDigest, String storedDigest) {
        if (!requestDigest.equals(storedDigest)) {
            throw new OperationIdReuseException(operationId);
        }
    }

    static void insertPrepared(
            DSLContext transaction,
            String operationId,
            String clientId,
            String operationType,
            String requestDigest,
            String stagingReference,
            String recoveryReference) {
        transaction.insertInto(OPERATIONS)
                .columns(
                        OPERATIONS.OPERATION_ID,
                        OPERATIONS.ACTOR_CLIENT_ID,
                        OPERATIONS.OPERATION_TYPE,
                        OPERATIONS.REQUEST_DIGEST,
                        OPERATIONS.STATUS,
                        OPERATIONS.STAGING_REFERENCE,
                        OPERATIONS.RECOVERY_REFERENCE,
                        OPERATIONS.CREATED_AT)
                .values(
                        operationId,
                        clientId,
                        operationType,
                        requestDigest,
                        "PREPARED",
                        stagingReference,
                        recoveryReference,
                        Instant.now().toString())
                .execute();
    }

    static void insertBase(
            DSLContext transaction,
            String operationId,
            int ordinal,
            String path,
            String expectedState,
            Long expectedRevision,
            String expectedHash) {
        transaction.insertInto(OPERATION_BASE_CONDITION)
                .columns(
                        OPERATION_BASE_CONDITION.OPERATION_ID,
                        OPERATION_BASE_CONDITION.ORDINAL,
                        OPERATION_BASE_CONDITION.PATH,
                        OPERATION_BASE_CONDITION.EXPECTED_STATE,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION,
                        OPERATION_BASE_CONDITION.EXPECTED_HASH)
                .values(operationId, ordinal, path, expectedState, expectedRevision, expectedHash)
                .execute();
    }

    static void markCommitted(DSLContext transaction, String operationId, long revision) {
        int completed = transaction.update(OPERATIONS)
                .set(OPERATIONS.STATUS, "COMMITTED")
                .set(OPERATIONS.RESULT_REVISION, revision)
                .set(OPERATIONS.COMPLETED_AT, Instant.now().toString())
                .where(OPERATIONS.OPERATION_ID.eq(operationId).and(OPERATIONS.STATUS.eq("PREPARED")))
                .execute();

        if (completed != 1) {
            throw new IllegalStateException("Prepared operation could not be finalized: " + operationId);
        }
    }
}
