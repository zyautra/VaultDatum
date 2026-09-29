package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_RENAME;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationRename;
import io.vaultdatum.server.jooq.tables.Operations;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

@ApplicationScoped
public final class PathChangeCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final VaultDriftGuard driftGuard;

    public PathChangeCoordinator(DataDirectories dataDirectories, DSLContext dsl, VaultDriftGuard driftGuard) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.driftGuard = driftGuard;
    }

    public OperationResult commit(PathChangeOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            OperationResult replayed = OperationRecords.replay(dsl, operation.operationId(), requestDigest(operation));
            if (replayed != null) {
                return replayed;
            }
            driftGuard.requireRecordedFile(operation.sourcePath());
            driftGuard.requireUnrecordedPathAbsent(operation.destinationPath());
            prepare(operation);
            apply(operation);
            return finalize(operation);
        }
    }

    public void recoverPreparedPathChanges() {
        synchronized (MutationLock.INSTANCE) {
            Operations operations = OPERATIONS.as("operations");
            OperationRename renames = OPERATION_RENAME.as("operation_rename");
            var prepared = dsl.select(
                            operations.OPERATION_ID,
                            operations.ACTOR_CLIENT_ID,
                            operations.OPERATION_TYPE,
                            operations.REQUEST_DIGEST,
                            renames.SOURCE_PATH,
                            renames.DESTINATION_PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_REVISION,
                            OPERATION_BASE_CONDITION.EXPECTED_HASH)
                    .from(operations)
                    .join(renames).on(renames.OPERATION_ID.eq(operations.OPERATION_ID))
                    .join(OPERATION_BASE_CONDITION)
                    .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(operations.OPERATION_ID))
                    .where(operations.STATUS.eq("PREPARED"))
                    .and(operations.OPERATION_TYPE.in("RENAME", "MOVE"))
                    .and(OPERATION_BASE_CONDITION.ORDINAL.eq(0))
                    .fetch();

            for (var record : prepared) {
                PathChangeOperation operation = new PathChangeOperation(
                        record.get(operations.OPERATION_ID),
                        record.get(operations.ACTOR_CLIENT_ID),
                        PathChangeType.valueOf(record.get(operations.OPERATION_TYPE)),
                        SyncPath.parse(record.get(renames.SOURCE_PATH)),
                        SyncPath.parse(record.get(renames.DESTINATION_PATH)),
                        new PresentBase(
                                record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION),
                                record.get(OPERATION_BASE_CONDITION.EXPECTED_HASH)));
                OperationRecords.requireMatchingDigest(
                        operation.operationId(), requestDigest(operation), record.get(operations.REQUEST_DIGEST));
                apply(operation);
                finalize(operation);
            }
        }
    }

    private void prepare(PathChangeOperation operation) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var source = transaction.select(
                            PATH_STATE.ENTRY_TYPE,
                            PATH_STATE.STATE,
                            PATH_STATE.LATEST_REVISION,
                            PATH_STATE.CONTENT_HASH)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.sourcePath().value()))
                    .fetchOne();
            boolean destinationKnown = transaction.fetchExists(
                    transaction.selectOne().from(PATH_STATE)
                            .where(PATH_STATE.PATH.eq(operation.destinationPath().value())));
            if (source == null || !"FILE".equals(source.get(PATH_STATE.ENTRY_TYPE))
                    || !"PRESENT".equals(source.get(PATH_STATE.STATE))
                    || source.get(PATH_STATE.LATEST_REVISION) != operation.sourceBase().revision()
                    || !operation.sourceBase().contentHash().equals(source.get(PATH_STATE.CONTENT_HASH))
                    || destinationKnown) {
                throw new BaseStateMismatchException("The rename base does not match the authoritative Vault");
            }
            OperationRecords.insertPrepared(
                    transaction,
                    operation.operationId(),
                    operation.clientId(),
                    operation.type().name(),
                    requestDigest(operation),
                    null,
                    null);
            OperationRecords.insertBase(
                    transaction,
                    operation.operationId(),
                    0,
                    operation.sourcePath().value(),
                    "PRESENT",
                    operation.sourceBase().revision(),
                    operation.sourceBase().contentHash());
            OperationRecords.insertBase(
                    transaction, operation.operationId(), 1, operation.destinationPath().value(), "UNKNOWN", null, null);
            transaction.insertInto(OPERATION_RENAME)
                    .columns(OPERATION_RENAME.OPERATION_ID, OPERATION_RENAME.SOURCE_PATH, OPERATION_RENAME.DESTINATION_PATH)
                    .values(operation.operationId(), operation.sourcePath().value(), operation.destinationPath().value())
                    .execute();
        });
    }

    private void apply(PathChangeOperation operation) {
        Path source = operation.sourcePath().resolveUnder(dataDirectories.vault());
        Path destination = operation.destinationPath().resolveUnder(dataDirectories.vault());
        if (VaultFiles.hasContent(destination, operation.sourceBase().contentHash()) && !Files.exists(source)) {
            return;
        }
        if (!VaultFiles.hasContent(source, operation.sourceBase().contentHash()) || Files.exists(destination)) {
            throw new RecoveryRequiredException(operation.operationId());
        }
        try {
            Files.createDirectories(destination.getParent());
            Files.move(source, destination, StandardCopyOption.ATOMIC_MOVE);
            VaultFiles.forceDirectoriesUpTo(source.getParent(), dataDirectories.vault());
            VaultFiles.forceDirectoriesUpTo(destination.getParent(), dataDirectories.vault());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private OperationResult finalize(PathChangeOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var source = transaction.select(PATH_STATE.SIZE)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.sourcePath().value()))
                    .fetchOne();
            if (source == null || source.get(PATH_STATE.SIZE) == null) {
                throw new IllegalStateException("Rename source state was lost before finalization");
            }
            long revision = ChangeJournal.nextRevision(transaction);
            int deleted = transaction.update(PATH_STATE)
                    .set(PATH_STATE.STATE, "DELETED")
                    .set(PATH_STATE.LATEST_REVISION, revision)
                    .setNull(PATH_STATE.CONTENT_HASH)
                    .setNull(PATH_STATE.SIZE)
                    .set(PATH_STATE.LAST_CONTENT_HASH, operation.sourceBase().contentHash())
                    .where(PATH_STATE.PATH.eq(operation.sourcePath().value()))
                    .execute();
            if (deleted != 1) {
                throw new IllegalStateException("Rename source state could not be finalized");
            }
            transaction.insertInto(PATH_STATE)
                    .columns(PATH_STATE.PATH, PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION,
                            PATH_STATE.CONTENT_HASH, PATH_STATE.SIZE)
                    .values(operation.destinationPath().value(), "FILE", "PRESENT", revision,
                            operation.sourceBase().contentHash(), source.get(PATH_STATE.SIZE))
                    .execute();
            ChangeJournal.appendClientChange(
                    transaction,
                    revision,
                    operation.operationId(),
                    operation.type().name(),
                    operation.clientId(),
                    operation.sourcePath().value(),
                    operation.destinationPath().value());
            ChangeJournal.appendDeleted(transaction, revision, 0, operation.sourcePath().value(), "FILE");
            ChangeJournal.appendPresentFile(
                    transaction,
                    revision,
                    1,
                    operation.destinationPath().value(),
                    operation.sourceBase().contentHash(),
                    source.get(PATH_STATE.SIZE));
            OperationRecords.markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private static String requestDigest(PathChangeOperation operation) {
        String request = String.join("\u0000",
                operation.operationId(), operation.clientId(), operation.sourcePath().value(),
                operation.destinationPath().value(), Long.toString(operation.sourceBase().revision()),
                operation.sourceBase().contentHash(), "UNKNOWN");
        return operation.type() == PathChangeType.RENAME
                ? ContentHash.calculateUtf8(request)
                : ContentHash.calculateUtf8(request + "\u0000" + operation.type().name());
    }
}
