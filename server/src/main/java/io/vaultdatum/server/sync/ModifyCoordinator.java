package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_MODIFY;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationModify;
import io.vaultdatum.server.jooq.tables.Operations;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

@ApplicationScoped
public final class ModifyCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final VaultDriftGuard driftGuard;

    private final ContentHistory contentHistory;

    public ModifyCoordinator(
            DataDirectories dataDirectories,
            DSLContext dsl,
            VaultDriftGuard driftGuard,
            ContentHistory contentHistory) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.driftGuard = driftGuard;
        this.contentHistory = contentHistory;
    }

    public OperationResult commit(ModifyOperation operation, Path stagedContent) {
        synchronized (MutationLock.INSTANCE) {
            return commitLocked(operation, stagedContent);
        }
    }

    private OperationResult commitLocked(ModifyOperation operation, Path stagedContent) {
        OperationResult replayed = OperationRecords.replay(dsl, operation.operationId(), requestDigest(operation));

        if (replayed != null) {
            return replayed;
        }

        Path staged = dataDirectories.requireStagedFile(stagedContent);
        VaultFiles.forceDirectory(staged.getParent());
        driftGuard.requireRecordedFile(operation.path());
        prepare(operation, staged);
        apply(operation, staged);
        OperationResult result = finalize(operation);
        contentHistory.retain(recoveryPath(operation), operation.base().contentHash());
        return result;
    }

    public void recoverPreparedModifies() {
        synchronized (MutationLock.INSTANCE) {
            recoverPreparedModifiesLocked();
        }
    }

    private void recoverPreparedModifiesLocked() {
        Operations operations = OPERATIONS.as("operations");
        OperationModify modifies = OPERATION_MODIFY.as("operation_modify");
        var prepared = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.REQUEST_DIGEST,
                        operations.STAGING_REFERENCE,
                        modifies.PATH,
                        modifies.CONTENT_HASH,
                        modifies.SIZE,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION,
                        OPERATION_BASE_CONDITION.EXPECTED_HASH)
                .from(operations)
                .join(modifies).on(modifies.OPERATION_ID.eq(operations.OPERATION_ID))
                .join(OPERATION_BASE_CONDITION)
                .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .and(operations.OPERATION_TYPE.eq("MODIFY"))
                .fetch();

        for (var record : prepared) {
            ModifyOperation operation = new ModifyOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    SyncPath.parse(record.get(modifies.PATH)),
                    new PresentBase(
                            record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION),
                            record.get(OPERATION_BASE_CONDITION.EXPECTED_HASH)),
                    record.get(modifies.CONTENT_HASH),
                    record.get(modifies.SIZE));
            OperationRecords.requireMatchingDigest(
                    operation.operationId(), requestDigest(operation), record.get(operations.REQUEST_DIGEST));
            apply(operation, dataDirectories.stagedFile(record.get(operations.STAGING_REFERENCE)));
            finalize(operation);
            contentHistory.retain(recoveryPath(operation), operation.base().contentHash());
        }
    }

    private void prepare(ModifyOperation operation, Path stagedContent) {
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
                throw new BaseStateMismatchException("The modify base does not match the authoritative Vault");
            }

            OperationRecords.insertPrepared(
                    transaction,
                    operation.operationId(),
                    operation.clientId(),
                    "MODIFY",
                    requestDigest(operation),
                    stagedContent.getFileName().toString(),
                    recoveryReference(operation));
            OperationRecords.insertBase(
                    transaction,
                    operation.operationId(),
                    0,
                    operation.path().value(),
                    "PRESENT",
                    operation.base().revision(),
                    operation.base().contentHash());
            transaction.insertInto(OPERATION_MODIFY)
                    .columns(
                            OPERATION_MODIFY.OPERATION_ID,
                            OPERATION_MODIFY.PATH,
                            OPERATION_MODIFY.CONTENT_HASH,
                            OPERATION_MODIFY.SIZE)
                    .values(
                            operation.operationId(),
                            operation.path().value(),
                            operation.contentHash(),
                            operation.size())
                    .execute();
        });
    }

    private void apply(ModifyOperation operation, Path stagedContent) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());
        Path recovery = recoveryPath(operation);

        try {
            if (VaultFiles.hasContent(target, operation.contentHash(), operation.size())) {
                return;
            }
            if (!Files.isRegularFile(stagedContent)) {
                throw new RecoveryRequiredException(operation.operationId());
            }
            if (VaultFiles.hasContent(target, operation.base().contentHash())) {
                Files.move(target, recovery, StandardCopyOption.ATOMIC_MOVE);
                VaultFiles.forceDirectoriesUpTo(target.getParent(), dataDirectories.vault());
                VaultFiles.forceDirectory(recovery.getParent());
            } else if (!VaultFiles.hasContent(recovery, operation.base().contentHash())) {
                throw new RecoveryRequiredException(operation.operationId());
            }

            Files.move(stagedContent, target, StandardCopyOption.ATOMIC_MOVE);
            VaultFiles.forceDirectoriesUpTo(target.getParent(), dataDirectories.vault());
            VaultFiles.forceDirectory(stagedContent.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private OperationResult finalize(ModifyOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = ChangeJournal.nextRevision(transaction);
            int updatedPath = transaction.update(PATH_STATE)
                    .set(PATH_STATE.STATE, "PRESENT")
                    .set(PATH_STATE.LATEST_REVISION, revision)
                    .set(PATH_STATE.CONTENT_HASH, operation.contentHash())
                    .set(PATH_STATE.SIZE, operation.size())
                    .where(PATH_STATE.PATH.eq(operation.path().value()))
                    .execute();

            if (updatedPath != 1) {
                throw new IllegalStateException("Modify path state was lost before finalization");
            }
            ChangeJournal.appendClientChange(
                    transaction, revision, operation.operationId(), "MODIFY", operation.clientId(), null, null);
            ChangeJournal.appendPresentFile(
                    transaction, revision, 0, operation.path().value(), operation.contentHash(), operation.size());
            OperationRecords.markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private static String requestDigest(ModifyOperation operation) {
        return ContentHash.calculateUtf8(String.join(
                "\u0000",
                operation.operationId(),
                operation.clientId(),
                operation.path().value(),
                Long.toString(operation.base().revision()),
                operation.base().contentHash(),
                operation.contentHash(),
                Long.toString(operation.size())));
    }

    private Path recoveryPath(ModifyOperation operation) {
        return dataDirectories.recovery().resolve(recoveryReference(operation));
    }

    private static String recoveryReference(ModifyOperation operation) {
        return "modify-" + operation.operationId() + ".bak";
    }
}
