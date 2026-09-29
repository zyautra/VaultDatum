package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_CREATE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationCreate;
import io.vaultdatum.server.jooq.tables.Operations;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

@ApplicationScoped
public final class CreateCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final VaultDriftGuard driftGuard;

    public CreateCoordinator(DataDirectories dataDirectories, DSLContext dsl, VaultDriftGuard driftGuard) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.driftGuard = driftGuard;
    }

    public OperationResult commit(CreateOperation operation, Path stagedContent) {
        synchronized (MutationLock.INSTANCE) {
            return commitLocked(operation, stagedContent);
        }
    }

    private OperationResult commitLocked(CreateOperation operation, Path stagedContent) {
        OperationResult replayed = OperationRecords.replay(dsl, operation.operationId(), requestDigest(operation));

        if (replayed != null) {
            return replayed;
        }

        Path normalizedStaging = dataDirectories.requireStagedFile(stagedContent);
        driftGuard.requireUnrecordedPathAbsent(operation.path());
        ensureTargetIsAbsent(operation);
        VaultFiles.forceDirectory(normalizedStaging.getParent());
        prepare(operation, normalizedStaging);
        apply(operation, normalizedStaging);
        return finalize(operation);
    }

    public void recoverPreparedCreates() {
        synchronized (MutationLock.INSTANCE) {
            recoverPreparedCreatesLocked();
        }
    }

    private void recoverPreparedCreatesLocked() {
        Operations operations = OPERATIONS.as("operations");
        OperationCreate operationCreates = OPERATION_CREATE.as("operation_create");
        var preparedOperations = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.REQUEST_DIGEST,
                        operations.STAGING_REFERENCE,
                        operationCreates.PATH,
                        operationCreates.CONTENT_HASH,
                        operationCreates.SIZE,
                        OPERATION_BASE_CONDITION.EXPECTED_STATE,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION)
                .from(operations)
                .join(operationCreates)
                .on(operationCreates.OPERATION_ID.eq(operations.OPERATION_ID))
                .join(OPERATION_BASE_CONDITION)
                .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .fetch();

        for (var record : preparedOperations) {
            CreateOperation operation = new CreateOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    SyncPath.parse(record.get(operationCreates.PATH)),
                    createBase(
                            record.get(OPERATION_BASE_CONDITION.EXPECTED_STATE),
                            record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION)),
                    record.get(operationCreates.CONTENT_HASH),
                    record.get(operationCreates.SIZE));
            if (!requestDigest(operation).equals(record.get(operations.REQUEST_DIGEST))) {
                throw new IllegalStateException("Prepared operation request digest does not match: "
                        + operation.operationId());
            }

            apply(operation, dataDirectories.stagedFile(record.get(operations.STAGING_REFERENCE)));
            finalize(operation);
        }
    }

    private void ensureTargetIsAbsent(CreateOperation operation) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());

        if (Files.exists(target)) {
            throw new BaseStateMismatchException("The create path already exists in the authoritative Vault");
        }
    }

    private void prepare(CreateOperation operation, Path stagedContent) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var pathState = transaction.select(
                            PATH_STATE.ENTRY_TYPE,
                            PATH_STATE.STATE,
                            PATH_STATE.LATEST_REVISION)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.path().value()))
                    .fetchOne();
            validateBase(operation, pathState);

            OperationRecords.insertPrepared(
                    transaction,
                    operation.operationId(),
                    operation.clientId(),
                    "CREATE",
                    requestDigest(operation),
                    stagedContent.getFileName().toString(),
                    null);
            OperationRecords.insertBase(
                    transaction,
                    operation.operationId(),
                    0,
                    operation.path().value(),
                    baseState(operation.base()),
                    baseRevision(operation.base()),
                    null);
            transaction.insertInto(OPERATION_CREATE)
                    .columns(
                            OPERATION_CREATE.OPERATION_ID,
                            OPERATION_CREATE.PATH,
                            OPERATION_CREATE.CONTENT_HASH,
                            OPERATION_CREATE.SIZE)
                    .values(operation.operationId(), operation.path().value(), operation.contentHash(), operation.size())
                    .execute();
        });
    }

    private void apply(CreateOperation operation, Path stagedContent) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());

        try {
            if (Files.exists(target)) {
                if (VaultFiles.hasContent(target, operation.contentHash(), operation.size())) {
                    return;
                }
                throw new RecoveryRequiredException(operation.operationId());
            }
            if (!Files.isRegularFile(stagedContent)) {
                throw new RecoveryRequiredException(operation.operationId());
            }

            Files.createDirectories(target.getParent());
            Files.move(stagedContent, target, StandardCopyOption.ATOMIC_MOVE);
            VaultFiles.forceDirectoriesUpTo(target.getParent(), dataDirectories.vault());
            VaultFiles.forceDirectory(stagedContent.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private OperationResult finalize(CreateOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = ChangeJournal.nextRevision(transaction);
            if (operation.base() instanceof UnknownCreateBase) {
                transaction.insertInto(PATH_STATE)
                        .columns(
                                PATH_STATE.PATH,
                                PATH_STATE.ENTRY_TYPE,
                                PATH_STATE.STATE,
                                PATH_STATE.LATEST_REVISION,
                                PATH_STATE.CONTENT_HASH,
                                PATH_STATE.SIZE)
                        .values(
                                operation.path().value(),
                                "FILE",
                                "PRESENT",
                                revision,
                                operation.contentHash(),
                                operation.size())
                        .execute();
            } else {
                int restored = transaction.update(PATH_STATE)
                        .set(PATH_STATE.ENTRY_TYPE, "FILE")
                        .set(PATH_STATE.STATE, "PRESENT")
                        .set(PATH_STATE.LATEST_REVISION, revision)
                        .set(PATH_STATE.CONTENT_HASH, operation.contentHash())
                        .set(PATH_STATE.SIZE, operation.size())
                        .setNull(PATH_STATE.LAST_CONTENT_HASH)
                        .where(PATH_STATE.PATH.eq(operation.path().value()))
                        .and(PATH_STATE.STATE.eq("DELETED"))
                        .execute();

                if (restored != 1) {
                    throw new IllegalStateException("Deleted create path state was lost before finalization");
                }
            }
            ChangeJournal.appendClientChange(
                    transaction, revision, operation.operationId(), "CREATE", operation.clientId(), null, null);
            ChangeJournal.appendPresentFile(
                    transaction, revision, 0, operation.path().value(), operation.contentHash(), operation.size());
            OperationRecords.markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private static String requestDigest(CreateOperation operation) {
        return ContentHash.calculateUtf8(String.join("\u0000",
                operation.operationId(),
                operation.clientId(),
                operation.path().value(),
                baseState(operation.base()),
                baseRevision(operation.base()) == null ? "" : Long.toString(baseRevision(operation.base())),
                operation.contentHash(),
                Long.toString(operation.size())));
    }

    private static CreateBase createBase(String state, Long revision) {
        if ("UNKNOWN".equals(state) && revision == null) {
            return UnknownCreateBase.INSTANCE;
        }
        if ("DELETED".equals(state) && revision != null && revision >= 1) {
            return new DeletedCreateBase(revision);
        }

        throw new IllegalStateException("Prepared create has an invalid base condition");
    }

    private static void validateBase(CreateOperation operation, org.jooq.Record pathState) {
        if (operation.base() instanceof UnknownCreateBase && pathState == null) {
            return;
        }
        if (operation.base() instanceof DeletedCreateBase deleted && pathState != null
                && "FILE".equals(pathState.get(PATH_STATE.ENTRY_TYPE))
                && "DELETED".equals(pathState.get(PATH_STATE.STATE))
                && deleted.revision() == pathState.get(PATH_STATE.LATEST_REVISION)) {
            return;
        }

        throw new BaseStateMismatchException("The create base does not match the authoritative Vault");
    }

    private static String baseState(CreateBase base) {
        return base instanceof UnknownCreateBase ? "UNKNOWN" : "DELETED";
    }

    private static Long baseRevision(CreateBase base) {
        return base instanceof DeletedCreateBase deleted ? deleted.revision() : null;
    }
}
