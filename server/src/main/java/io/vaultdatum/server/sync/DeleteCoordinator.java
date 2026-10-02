package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DELETE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationDelete;
import io.vaultdatum.server.jooq.tables.Operations;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

@ApplicationScoped
public final class DeleteCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final VaultDriftGuard driftGuard;

    private final ContentHistory contentHistory;

    private final ImplicitParentDirectories implicitParents;

    public DeleteCoordinator(
            DataDirectories dataDirectories,
            DSLContext dsl,
            VaultDriftGuard driftGuard,
            ContentHistory contentHistory,
            ImplicitParentDirectories implicitParents) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.driftGuard = driftGuard;
        this.contentHistory = contentHistory;
        this.implicitParents = implicitParents;
    }

    public OperationResult commit(DeleteOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            return commitLocked(operation);
        }
    }

    private OperationResult commitLocked(DeleteOperation operation) {
        OperationResult replayed = OperationRecords.replay(dsl, operation.operationId(), requestDigest(operation));

        if (replayed != null) {
            return replayed;
        }

        driftGuard.requireRecordedFile(operation.path());
        prepare(operation);
        apply(operation);
        OperationResult result = finalize(operation);
        implicitParents.pruneAbove(operation.path());
        contentHistory.retain(recoveryPath(operation), operation.base().contentHash());
        return result;
    }

    public void recoverPreparedDeletes() {
        synchronized (MutationLock.INSTANCE) {
            recoverPreparedDeletesLocked();
        }
    }

    private void recoverPreparedDeletesLocked() {
        Operations operations = OPERATIONS.as("operations");
        OperationDelete deletes = OPERATION_DELETE.as("operation_delete");
        var prepared = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.REQUEST_DIGEST,
                        deletes.PATH,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION,
                        OPERATION_BASE_CONDITION.EXPECTED_HASH)
                .from(operations)
                .join(deletes).on(deletes.OPERATION_ID.eq(operations.OPERATION_ID))
                .join(OPERATION_BASE_CONDITION)
                .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .and(operations.OPERATION_TYPE.eq("DELETE"))
                .fetch();

        for (var record : prepared) {
            DeleteOperation operation = new DeleteOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    SyncPath.parse(record.get(deletes.PATH)),
                    new PresentBase(
                            record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION),
                            record.get(OPERATION_BASE_CONDITION.EXPECTED_HASH)));
            OperationRecords.requireMatchingDigest(
                    operation.operationId(), requestDigest(operation), record.get(operations.REQUEST_DIGEST));
            apply(operation);
            finalize(operation);
            implicitParents.pruneAbove(operation.path());
            contentHistory.retain(recoveryPath(operation), operation.base().contentHash());
        }
    }

    private void prepare(DeleteOperation operation) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var state = transaction.select(
                            PATH_STATE.STATE,
                            PATH_STATE.ENTRY_TYPE,
                            PATH_STATE.LATEST_REVISION,
                            PATH_STATE.CONTENT_HASH)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.path().value()))
                    .fetchOne();

            if (state == null || !"PRESENT".equals(state.get(PATH_STATE.STATE))
                    || !"FILE".equals(state.get(PATH_STATE.ENTRY_TYPE))
                    || state.get(PATH_STATE.LATEST_REVISION) != operation.base().revision()
                    || !operation.base().contentHash().equals(state.get(PATH_STATE.CONTENT_HASH))) {
                throw new BaseStateMismatchException("The delete base does not match the authoritative Vault");
            }

            OperationRecords.insertPrepared(
                    transaction,
                    operation.operationId(),
                    operation.clientId(),
                    "DELETE",
                    requestDigest(operation),
                    null,
                    recoveryReference(operation));
            OperationRecords.insertBase(
                    transaction,
                    operation.operationId(),
                    0,
                    operation.path().value(),
                    "PRESENT",
                    operation.base().revision(),
                    operation.base().contentHash());
            transaction.insertInto(OPERATION_DELETE)
                    .columns(OPERATION_DELETE.OPERATION_ID, OPERATION_DELETE.PATH)
                    .values(operation.operationId(), operation.path().value())
                    .execute();
        });
    }

    private void apply(DeleteOperation operation) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());
        Path recovery = recoveryPath(operation);

        if (VaultFiles.hasContent(target, operation.base().contentHash())) {
            try {
                Files.move(target, recovery, StandardCopyOption.ATOMIC_MOVE);
                VaultFiles.forceDirectoriesUpTo(target.getParent(), dataDirectories.vault());
                VaultFiles.forceDirectory(recovery.getParent());
                return;
            } catch (IOException exception) {
                throw new RecoveryRequiredException(operation.operationId(), exception);
            }
        }
        if (!VaultFiles.hasContent(recovery, operation.base().contentHash()) || Files.exists(target)) {
            throw new RecoveryRequiredException(operation.operationId());
        }
    }

    private OperationResult finalize(DeleteOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = ChangeJournal.nextRevision(transaction);
            int updatedPath = transaction.update(PATH_STATE)
                    .set(PATH_STATE.STATE, "DELETED")
                    .set(PATH_STATE.LATEST_REVISION, revision)
                    .setNull(PATH_STATE.CONTENT_HASH)
                    .setNull(PATH_STATE.SIZE)
                    .set(PATH_STATE.LAST_CONTENT_HASH, operation.base().contentHash())
                    .where(PATH_STATE.PATH.eq(operation.path().value()))
                    .execute();

            if (updatedPath != 1) {
                throw new IllegalStateException("Delete path state was lost before finalization");
            }
            ChangeJournal.appendClientChange(
                    transaction, revision, operation.operationId(), "DELETE", operation.clientId(), null, null);
            ChangeJournal.appendDeleted(transaction, revision, 0, operation.path().value(), "FILE");
            OperationRecords.markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private static String requestDigest(DeleteOperation operation) {
        return ContentHash.calculateUtf8(String.join(
                "\u0000",
                operation.operationId(),
                operation.clientId(),
                operation.path().value(),
                Long.toString(operation.base().revision()),
                operation.base().contentHash()));
    }

    private Path recoveryPath(DeleteOperation operation) {
        return dataDirectories.recovery().resolve(recoveryReference(operation));
    }

    private static String recoveryReference(DeleteOperation operation) {
        return "delete-" + operation.operationId() + ".bak";
    }
}
