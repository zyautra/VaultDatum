package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_MODIFY;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationModify;
import io.vaultdatum.server.jooq.tables.Operations;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;

@ApplicationScoped
public final class ModifyCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public ModifyCoordinator(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public OperationResult commit(ModifyOperation operation, Path stagedContent) {
        synchronized (MutationLock.INSTANCE) {
            return commitLocked(operation, stagedContent);
        }
    }

    private OperationResult commitLocked(ModifyOperation operation, Path stagedContent) {
        OperationResult replayed = existingResult(operation);

        if (replayed != null) {
            return replayed;
        }

        Path staged = requireStagedContent(stagedContent);
        forceDirectory(staged.getParent());
        prepare(operation, staged);
        apply(operation, staged);
        OperationResult result = finalize(operation);
        discardRecovery(operation);
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
            requireMatchingDigest(operation, record.get(operations.REQUEST_DIGEST));
            apply(operation, stagingPath(record.get(operations.STAGING_REFERENCE)));
            finalize(operation);
            discardRecovery(operation);
        }
    }

    private OperationResult existingResult(ModifyOperation operation) {
        var record = dsl.select(OPERATIONS.STATUS, OPERATIONS.RESULT_REVISION, OPERATIONS.REQUEST_DIGEST)
                .from(OPERATIONS)
                .where(OPERATIONS.OPERATION_ID.eq(operation.operationId()))
                .fetchOne();

        if (record == null) {
            return null;
        }
        requireMatchingDigest(operation, record.get(OPERATIONS.REQUEST_DIGEST));
        if (!"COMMITTED".equals(record.get(OPERATIONS.STATUS))) {
            throw new RecoveryRequiredException(operation.operationId());
        }

        return new OperationResult(operation.operationId(), record.get(OPERATIONS.RESULT_REVISION), true);
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
                            operation.operationId(),
                            operation.clientId(),
                            "MODIFY",
                            requestDigest(operation),
                            "PREPARED",
                            stagedContent.getFileName().toString(),
                            recoveryReference(operation),
                            Instant.now().toString())
                    .execute();
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE,
                            OPERATION_BASE_CONDITION.EXPECTED_REVISION,
                            OPERATION_BASE_CONDITION.EXPECTED_HASH)
                    .values(
                            operation.operationId(),
                            0,
                            operation.path().value(),
                            "PRESENT",
                            operation.base().revision(),
                            operation.base().contentHash())
                    .execute();
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
            if (matches(operation.contentHash(), operation.size(), target)) {
                return;
            }
            if (!Files.isRegularFile(stagedContent)) {
                throw new RecoveryRequiredException(operation.operationId());
            }
            if (matches(operation.base().contentHash(), -1, target)) {
                Files.move(target, recovery, StandardCopyOption.ATOMIC_MOVE);
                forceVaultDirectories(target.getParent());
                forceDirectory(recovery.getParent());
            } else if (!matches(operation.base().contentHash(), -1, recovery)) {
                throw new RecoveryRequiredException(operation.operationId());
            }

            Files.move(stagedContent, target, StandardCopyOption.ATOMIC_MOVE);
            forceVaultDirectories(target.getParent());
            forceDirectory(stagedContent.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private OperationResult finalize(ModifyOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = nextRevision(transaction);
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
            recordChange(transaction, operation, revision);
            completeOperation(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private long nextRevision(DSLContext transaction) {
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

    private void recordChange(DSLContext transaction, ModifyOperation operation, long revision) {
        transaction.insertInto(CHANGE_JOURNAL)
                .columns(
                        CHANGE_JOURNAL.REVISION,
                        CHANGE_JOURNAL.OPERATION_ID,
                        CHANGE_JOURNAL.CHANGE_TYPE,
                        CHANGE_JOURNAL.ACTOR_TYPE,
                        CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                        CHANGE_JOURNAL.COMMITTED_AT)
                .values(revision, operation.operationId(), "MODIFY", "CLIENT", operation.clientId(), Instant.now().toString())
                .execute();
        transaction.insertInto(CHANGE_EFFECT)
                .columns(
                        CHANGE_EFFECT.REVISION,
                        CHANGE_EFFECT.ORDINAL,
                        CHANGE_EFFECT.PATH,
                        CHANGE_EFFECT.ENTRY_TYPE,
                        CHANGE_EFFECT.STATE,
                        CHANGE_EFFECT.CONTENT_HASH,
                        CHANGE_EFFECT.SIZE)
                .values(
                        revision,
                        0,
                        operation.path().value(),
                        "FILE",
                        "PRESENT",
                        operation.contentHash(),
                        operation.size())
                .execute();
    }

    private void completeOperation(DSLContext transaction, String operationId, long revision) {
        int completed = transaction.update(OPERATIONS)
                .set(OPERATIONS.STATUS, "COMMITTED")
                .set(OPERATIONS.RESULT_REVISION, revision)
                .set(OPERATIONS.COMPLETED_AT, Instant.now().toString())
                .where(OPERATIONS.OPERATION_ID.eq(operationId).and(OPERATIONS.STATUS.eq("PREPARED")))
                .execute();

        if (completed != 1) {
            throw new IllegalStateException("Prepared modify could not be finalized: " + operationId);
        }
    }

    private void requireMatchingDigest(ModifyOperation operation, String storedDigest) {
        if (!requestDigest(operation).equals(storedDigest)) {
            throw new OperationIdReuseException(operation.operationId());
        }
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

    private Path requireStagedContent(Path stagedContent) {
        Path normalized = stagedContent.toAbsolutePath().normalize();

        if (!normalized.getParent().equals(dataDirectories.staging()) || !Files.isRegularFile(normalized)) {
            throw new IllegalArgumentException("Modify content must be staged under the server staging directory");
        }

        return normalized;
    }

    private Path stagingPath(String reference) {
        if (reference == null || reference.isBlank()) {
            throw new IllegalStateException("Missing staging reference in operation metadata");
        }

        Path staged = dataDirectories.staging().resolve(reference).normalize();
        if (!staged.getParent().equals(dataDirectories.staging())) {
            throw new IllegalStateException("Invalid staging reference in operation metadata");
        }
        return staged;
    }

    private Path recoveryPath(ModifyOperation operation) {
        return dataDirectories.recovery().resolve(recoveryReference(operation));
    }

    private static String recoveryReference(ModifyOperation operation) {
        return "modify-" + operation.operationId() + ".bak";
    }

    private void discardRecovery(ModifyOperation operation) {
        try {
            Files.deleteIfExists(recoveryPath(operation));
            forceDirectory(dataDirectories.recovery());
        } catch (IOException ignored) {
            // A retained backup is safe and can be collected after the committed state is durable.
        }
    }

    private static boolean matches(String expectedHash, long expectedSize, Path file) {
        if (!Files.isRegularFile(file)) {
            return false;
        }

        try {
            ContentHash.HashedContent actual = ContentHash.calculate(file);
            return expectedHash.equals(actual.value()) && (expectedSize < 0 || expectedSize == actual.size());
        } catch (IOException exception) {
            throw new IllegalStateException("Could not hash an authoritative file", exception);
        }
    }

    private static void forceDirectory(Path directory) {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not durably update directory: " + directory, exception);
        }
    }

    private void forceVaultDirectories(Path directory) {
        Path current = directory;

        while (true) {
            forceDirectory(current);
            if (current.equals(dataDirectories.vault())) {
                return;
            }
            current = current.getParent();
        }
    }
}
