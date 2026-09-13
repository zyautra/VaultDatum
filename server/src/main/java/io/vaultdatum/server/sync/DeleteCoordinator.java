package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DELETE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationDelete;
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
public final class DeleteCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public DeleteCoordinator(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public OperationResult commit(DeleteOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            return commitLocked(operation);
        }
    }

    private OperationResult commitLocked(DeleteOperation operation) {
        OperationResult replayed = existingResult(operation);

        if (replayed != null) {
            return replayed;
        }

        prepare(operation);
        apply(operation);
        OperationResult result = finalize(operation);
        discardRecovery(operation);
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
            requireMatchingDigest(operation, record.get(operations.REQUEST_DIGEST));
            apply(operation);
            finalize(operation);
            discardRecovery(operation);
        }
    }

    private OperationResult existingResult(DeleteOperation operation) {
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

            transaction.insertInto(OPERATIONS)
                    .columns(
                            OPERATIONS.OPERATION_ID,
                            OPERATIONS.ACTOR_CLIENT_ID,
                            OPERATIONS.OPERATION_TYPE,
                            OPERATIONS.REQUEST_DIGEST,
                            OPERATIONS.STATUS,
                            OPERATIONS.RECOVERY_REFERENCE,
                            OPERATIONS.CREATED_AT)
                    .values(
                            operation.operationId(),
                            operation.clientId(),
                            "DELETE",
                            requestDigest(operation),
                            "PREPARED",
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
            transaction.insertInto(OPERATION_DELETE)
                    .columns(OPERATION_DELETE.OPERATION_ID, OPERATION_DELETE.PATH)
                    .values(operation.operationId(), operation.path().value())
                    .execute();
        });
    }

    private void apply(DeleteOperation operation) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());
        Path recovery = recoveryPath(operation);

        if (matches(operation.base().contentHash(), target)) {
            try {
                Files.move(target, recovery, StandardCopyOption.ATOMIC_MOVE);
                forceVaultDirectories(target.getParent());
                forceDirectory(recovery.getParent());
                return;
            } catch (IOException exception) {
                throw new RecoveryRequiredException(operation.operationId(), exception);
            }
        }
        if (!matches(operation.base().contentHash(), recovery) || Files.exists(target)) {
            throw new RecoveryRequiredException(operation.operationId());
        }
    }

    private OperationResult finalize(DeleteOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = nextRevision(transaction);
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
            transaction.insertInto(CHANGE_JOURNAL)
                    .columns(
                            CHANGE_JOURNAL.REVISION,
                            CHANGE_JOURNAL.OPERATION_ID,
                            CHANGE_JOURNAL.CHANGE_TYPE,
                            CHANGE_JOURNAL.ACTOR_TYPE,
                            CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                            CHANGE_JOURNAL.COMMITTED_AT)
                    .values(revision, operation.operationId(), "DELETE", "CLIENT", operation.clientId(), Instant.now().toString())
                    .execute();
            transaction.insertInto(CHANGE_EFFECT)
                    .columns(
                            CHANGE_EFFECT.REVISION,
                            CHANGE_EFFECT.ORDINAL,
                            CHANGE_EFFECT.PATH,
                            CHANGE_EFFECT.ENTRY_TYPE,
                            CHANGE_EFFECT.STATE)
                    .values(revision, 0, operation.path().value(), "FILE", "DELETED")
                    .execute();
            int completed = transaction.update(OPERATIONS)
                    .set(OPERATIONS.STATUS, "COMMITTED")
                    .set(OPERATIONS.RESULT_REVISION, revision)
                    .set(OPERATIONS.COMPLETED_AT, Instant.now().toString())
                    .where(OPERATIONS.OPERATION_ID.eq(operation.operationId()).and(OPERATIONS.STATUS.eq("PREPARED")))
                    .execute();

            if (completed != 1) {
                throw new IllegalStateException("Prepared delete could not be finalized: " + operation.operationId());
            }
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

    private void requireMatchingDigest(DeleteOperation operation, String storedDigest) {
        if (!requestDigest(operation).equals(storedDigest)) {
            throw new OperationIdReuseException(operation.operationId());
        }
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

    private void discardRecovery(DeleteOperation operation) {
        try {
            Files.deleteIfExists(recoveryPath(operation));
            forceDirectory(dataDirectories.recovery());
        } catch (IOException ignored) {
            // A retained backup is safe and can be collected after the committed state is durable.
        }
    }

    private static boolean matches(String expectedHash, Path file) {
        if (!Files.isRegularFile(file)) {
            return false;
        }

        try {
            return expectedHash.equals(ContentHash.calculate(file).value());
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
