package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_RENAME;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationRename;
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
public final class RenameCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public RenameCoordinator(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public OperationResult commit(RenameOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            OperationResult replayed = existingResult(operation);
            if (replayed != null) {
                return replayed;
            }
            prepare(operation);
            apply(operation);
            return finalize(operation);
        }
    }

    public void recoverPreparedRenames() {
        synchronized (MutationLock.INSTANCE) {
            Operations operations = OPERATIONS.as("operations");
            OperationRename renames = OPERATION_RENAME.as("operation_rename");
            var prepared = dsl.select(
                            operations.OPERATION_ID,
                            operations.ACTOR_CLIENT_ID,
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
                    .and(operations.OPERATION_TYPE.eq("RENAME"))
                    .and(OPERATION_BASE_CONDITION.ORDINAL.eq(0))
                    .fetch();

            for (var record : prepared) {
                RenameOperation operation = new RenameOperation(
                        record.get(operations.OPERATION_ID),
                        record.get(operations.ACTOR_CLIENT_ID),
                        SyncPath.parse(record.get(renames.SOURCE_PATH)),
                        SyncPath.parse(record.get(renames.DESTINATION_PATH)),
                        new PresentBase(
                                record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION),
                                record.get(OPERATION_BASE_CONDITION.EXPECTED_HASH)));
                requireMatchingDigest(operation, record.get(operations.REQUEST_DIGEST));
                apply(operation);
                finalize(operation);
            }
        }
    }

    private OperationResult existingResult(RenameOperation operation) {
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

    private void prepare(RenameOperation operation) {
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
            transaction.insertInto(OPERATIONS)
                    .columns(
                            OPERATIONS.OPERATION_ID,
                            OPERATIONS.ACTOR_CLIENT_ID,
                            OPERATIONS.OPERATION_TYPE,
                            OPERATIONS.REQUEST_DIGEST,
                            OPERATIONS.STATUS,
                            OPERATIONS.CREATED_AT)
                    .values(
                            operation.operationId(),
                            operation.clientId(),
                            "RENAME",
                            requestDigest(operation),
                            "PREPARED",
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
                            operation.sourcePath().value(),
                            "PRESENT",
                            operation.sourceBase().revision(),
                            operation.sourceBase().contentHash())
                    .execute();
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE)
                    .values(operation.operationId(), 1, operation.destinationPath().value(), "UNKNOWN")
                    .execute();
            transaction.insertInto(OPERATION_RENAME)
                    .columns(OPERATION_RENAME.OPERATION_ID, OPERATION_RENAME.SOURCE_PATH, OPERATION_RENAME.DESTINATION_PATH)
                    .values(operation.operationId(), operation.sourcePath().value(), operation.destinationPath().value())
                    .execute();
        });
    }

    private void apply(RenameOperation operation) {
        Path source = operation.sourcePath().resolveUnder(dataDirectories.vault());
        Path destination = operation.destinationPath().resolveUnder(dataDirectories.vault());
        if (matches(operation.sourceBase().contentHash(), destination) && !Files.exists(source)) {
            return;
        }
        if (!matches(operation.sourceBase().contentHash(), source) || Files.exists(destination)) {
            throw new RecoveryRequiredException(operation.operationId());
        }
        try {
            Files.createDirectories(destination.getParent());
            Files.move(source, destination, StandardCopyOption.ATOMIC_MOVE);
            forceVaultDirectories(source.getParent());
            forceVaultDirectories(destination.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private OperationResult finalize(RenameOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var source = transaction.select(PATH_STATE.SIZE)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.sourcePath().value()))
                    .fetchOne();
            if (source == null || source.get(PATH_STATE.SIZE) == null) {
                throw new IllegalStateException("Rename source state was lost before finalization");
            }
            long revision = nextRevision(transaction);
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
            transaction.insertInto(CHANGE_JOURNAL)
                    .columns(CHANGE_JOURNAL.REVISION, CHANGE_JOURNAL.OPERATION_ID, CHANGE_JOURNAL.CHANGE_TYPE,
                            CHANGE_JOURNAL.ACTOR_TYPE, CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                            CHANGE_JOURNAL.SOURCE_PATH, CHANGE_JOURNAL.DESTINATION_PATH, CHANGE_JOURNAL.COMMITTED_AT)
                    .values(revision, operation.operationId(), "RENAME", "CLIENT", operation.clientId(),
                            operation.sourcePath().value(), operation.destinationPath().value(), Instant.now().toString())
                    .execute();
            transaction.insertInto(CHANGE_EFFECT)
                    .columns(CHANGE_EFFECT.REVISION, CHANGE_EFFECT.ORDINAL, CHANGE_EFFECT.PATH,
                            CHANGE_EFFECT.ENTRY_TYPE, CHANGE_EFFECT.STATE)
                    .values(revision, 0, operation.sourcePath().value(), "FILE", "DELETED")
                    .execute();
            transaction.insertInto(CHANGE_EFFECT)
                    .columns(CHANGE_EFFECT.REVISION, CHANGE_EFFECT.ORDINAL, CHANGE_EFFECT.PATH,
                            CHANGE_EFFECT.ENTRY_TYPE, CHANGE_EFFECT.STATE, CHANGE_EFFECT.CONTENT_HASH, CHANGE_EFFECT.SIZE)
                    .values(revision, 1, operation.destinationPath().value(), "FILE", "PRESENT",
                            operation.sourceBase().contentHash(), source.get(PATH_STATE.SIZE))
                    .execute();
            int completed = transaction.update(OPERATIONS)
                    .set(OPERATIONS.STATUS, "COMMITTED")
                    .set(OPERATIONS.RESULT_REVISION, revision)
                    .set(OPERATIONS.COMPLETED_AT, Instant.now().toString())
                    .where(OPERATIONS.OPERATION_ID.eq(operation.operationId()).and(OPERATIONS.STATUS.eq("PREPARED")))
                    .execute();
            if (completed != 1) {
                throw new IllegalStateException("Prepared rename could not be finalized: " + operation.operationId());
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

    private void requireMatchingDigest(RenameOperation operation, String storedDigest) {
        if (!requestDigest(operation).equals(storedDigest)) {
            throw new OperationIdReuseException(operation.operationId());
        }
    }

    private static String requestDigest(RenameOperation operation) {
        return ContentHash.calculateUtf8(String.join("\u0000",
                operation.operationId(), operation.clientId(), operation.sourcePath().value(),
                operation.destinationPath().value(), Long.toString(operation.sourceBase().revision()),
                operation.sourceBase().contentHash(), "UNKNOWN"));
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
