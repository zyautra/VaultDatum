package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DIRECTORY_CREATE;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DIRECTORY_DELETE;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DIRECTORY_PATH_CHANGE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationDirectoryCreate;
import io.vaultdatum.server.jooq.tables.OperationDirectoryDelete;
import io.vaultdatum.server.jooq.tables.OperationDirectoryPathChange;
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
public final class DirectoryCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public DirectoryCoordinator(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public OperationResult create(DirectoryCreateOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            OperationResult replayed = existingResult(operation.operationId(), requestDigest(operation));
            if (replayed != null) {
                return replayed;
            }
            if (Files.exists(operation.path().resolveUnder(dataDirectories.vault()))) {
                throw new BaseStateMismatchException("The directory create path already exists in the authoritative Vault");
            }
            prepareCreate(operation);
            applyCreate(operation);
            return finalizeCreate(operation);
        }
    }

    public OperationResult delete(DirectoryDeleteOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            OperationResult replayed = existingResult(operation.operationId(), requestDigest(operation));
            if (replayed != null) {
                return replayed;
            }
            ensureEmptyDirectory(operation.operationId(), operation.path(), "The directory delete path is not an empty directory");
            prepareDelete(operation);
            applyDelete(operation);
            return finalizeDelete(operation);
        }
    }

    public OperationResult changePath(DirectoryPathChangeOperation operation) {
        synchronized (MutationLock.INSTANCE) {
            OperationResult replayed = existingResult(operation.operationId(), requestDigest(operation));
            if (replayed != null) {
                return replayed;
            }
            if (Files.exists(operation.destinationPath().resolveUnder(dataDirectories.vault()))) {
                throw new BaseStateMismatchException("The directory destination already exists in the authoritative Vault");
            }
            ensureEmptyDirectory(
                    operation.operationId(), operation.sourcePath(), "The directory path-change source is not an empty directory");
            preparePathChange(operation);
            applyPathChange(operation);
            return finalizePathChange(operation);
        }
    }

    public void recoverPreparedDirectories() {
        synchronized (MutationLock.INSTANCE) {
            recoverPreparedCreates();
            recoverPreparedDeletes();
            recoverPreparedPathChanges();
        }
    }

    private void recoverPreparedCreates() {
        Operations operations = OPERATIONS.as("operations");
        OperationDirectoryCreate creates = OPERATION_DIRECTORY_CREATE.as("directory_create");
        var prepared = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.REQUEST_DIGEST,
                        creates.PATH)
                .from(operations)
                .join(creates).on(creates.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .and(operations.OPERATION_TYPE.eq("CREATE"))
                .fetch();
        for (var record : prepared) {
            DirectoryCreateOperation operation = new DirectoryCreateOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    SyncPath.parse(record.get(creates.PATH)));
            requireMatchingDigest(operation.operationId(), requestDigest(operation), record.get(operations.REQUEST_DIGEST));
            applyCreate(operation);
            finalizeCreate(operation);
        }
    }

    private void recoverPreparedDeletes() {
        Operations operations = OPERATIONS.as("operations");
        OperationDirectoryDelete deletes = OPERATION_DIRECTORY_DELETE.as("directory_delete");
        var prepared = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.REQUEST_DIGEST,
                        deletes.PATH,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION)
                .from(operations)
                .join(deletes).on(deletes.OPERATION_ID.eq(operations.OPERATION_ID))
                .join(OPERATION_BASE_CONDITION)
                .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .and(operations.OPERATION_TYPE.eq("DELETE"))
                .and(OPERATION_BASE_CONDITION.ORDINAL.eq(0))
                .fetch();
        for (var record : prepared) {
            DirectoryDeleteOperation operation = new DirectoryDeleteOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    SyncPath.parse(record.get(deletes.PATH)),
                    record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION));
            requireMatchingDigest(operation.operationId(), requestDigest(operation), record.get(operations.REQUEST_DIGEST));
            applyDelete(operation);
            finalizeDelete(operation);
        }
    }

    private void recoverPreparedPathChanges() {
        Operations operations = OPERATIONS.as("operations");
        OperationDirectoryPathChange changes = OPERATION_DIRECTORY_PATH_CHANGE.as("directory_path_change");
        var prepared = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.OPERATION_TYPE,
                        operations.REQUEST_DIGEST,
                        changes.SOURCE_PATH,
                        changes.DESTINATION_PATH,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION)
                .from(operations)
                .join(changes).on(changes.OPERATION_ID.eq(operations.OPERATION_ID))
                .join(OPERATION_BASE_CONDITION)
                .on(OPERATION_BASE_CONDITION.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .and(operations.OPERATION_TYPE.in("RENAME", "MOVE"))
                .and(OPERATION_BASE_CONDITION.ORDINAL.eq(0))
                .fetch();
        for (var record : prepared) {
            DirectoryPathChangeOperation operation = new DirectoryPathChangeOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    PathChangeType.valueOf(record.get(operations.OPERATION_TYPE)),
                    SyncPath.parse(record.get(changes.SOURCE_PATH)),
                    SyncPath.parse(record.get(changes.DESTINATION_PATH)),
                    record.get(OPERATION_BASE_CONDITION.EXPECTED_REVISION));
            requireMatchingDigest(operation.operationId(), requestDigest(operation), record.get(operations.REQUEST_DIGEST));
            applyPathChange(operation);
            finalizePathChange(operation);
        }
    }

    private OperationResult existingResult(String operationId, String digest) {
        var record = dsl.select(OPERATIONS.STATUS, OPERATIONS.RESULT_REVISION, OPERATIONS.REQUEST_DIGEST)
                .from(OPERATIONS)
                .where(OPERATIONS.OPERATION_ID.eq(operationId))
                .fetchOne();
        if (record == null) {
            return null;
        }
        requireMatchingDigest(operationId, digest, record.get(OPERATIONS.REQUEST_DIGEST));
        if (!"COMMITTED".equals(record.get(OPERATIONS.STATUS))) {
            throw new RecoveryRequiredException(operationId);
        }
        return new OperationResult(operationId, record.get(OPERATIONS.RESULT_REVISION), true);
    }

    private void prepareCreate(DirectoryCreateOperation operation) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            if (transaction.fetchExists(transaction.selectOne().from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.path().value())))) {
                throw new BaseStateMismatchException("The directory create base does not match the authoritative Vault");
            }
            insertPreparedOperation(transaction, operation.operationId(), operation.clientId(), "CREATE", requestDigest(operation));
            insertBase(transaction, operation.operationId(), 0, operation.path().value(), "UNKNOWN", null);
            transaction.insertInto(OPERATION_DIRECTORY_CREATE)
                    .columns(OPERATION_DIRECTORY_CREATE.OPERATION_ID, OPERATION_DIRECTORY_CREATE.PATH)
                    .values(operation.operationId(), operation.path().value())
                    .execute();
        });
    }

    private void prepareDelete(DirectoryDeleteOperation operation) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var state = transaction.select(PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.path().value()))
                    .fetchOne();
            if (!matchesDirectoryBase(state, operation.baseRevision())) {
                throw new BaseStateMismatchException("The directory delete base does not match the authoritative Vault");
            }
            insertPreparedOperation(transaction, operation.operationId(), operation.clientId(), "DELETE", requestDigest(operation));
            insertBase(transaction, operation.operationId(), 0, operation.path().value(), "PRESENT", operation.baseRevision());
            transaction.insertInto(OPERATION_DIRECTORY_DELETE)
                    .columns(OPERATION_DIRECTORY_DELETE.OPERATION_ID, OPERATION_DIRECTORY_DELETE.PATH)
                    .values(operation.operationId(), operation.path().value())
                    .execute();
        });
    }

    private void preparePathChange(DirectoryPathChangeOperation operation) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            var source = transaction.select(PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION)
                    .from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.sourcePath().value()))
                    .fetchOne();
            boolean destinationKnown = transaction.fetchExists(transaction.selectOne().from(PATH_STATE)
                    .where(PATH_STATE.PATH.eq(operation.destinationPath().value())));
            if (!matchesDirectoryBase(source, operation.sourceBaseRevision()) || destinationKnown) {
                throw new BaseStateMismatchException("The directory path-change base does not match the authoritative Vault");
            }
            insertPreparedOperation(
                    transaction, operation.operationId(), operation.clientId(), operation.type().name(), requestDigest(operation));
            insertBase(transaction, operation.operationId(), 0, operation.sourcePath().value(), "PRESENT", operation.sourceBaseRevision());
            insertBase(transaction, operation.operationId(), 1, operation.destinationPath().value(), "UNKNOWN", null);
            transaction.insertInto(OPERATION_DIRECTORY_PATH_CHANGE)
                    .columns(
                            OPERATION_DIRECTORY_PATH_CHANGE.OPERATION_ID,
                            OPERATION_DIRECTORY_PATH_CHANGE.SOURCE_PATH,
                            OPERATION_DIRECTORY_PATH_CHANGE.DESTINATION_PATH)
                    .values(operation.operationId(), operation.sourcePath().value(), operation.destinationPath().value())
                    .execute();
        });
    }

    private void applyCreate(DirectoryCreateOperation operation) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());
        try {
            if (Files.exists(target)) {
                if (Files.isDirectory(target) && isEmptyDirectory(target)) {
                    return;
                }
                throw new RecoveryRequiredException(operation.operationId());
            }
            Files.createDirectories(target.getParent());
            Files.createDirectory(target);
            forceVaultDirectories(target.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private void applyDelete(DirectoryDeleteOperation operation) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());
        try {
            if (!Files.exists(target)) {
                return;
            }
            if (!Files.isDirectory(target) || !isEmptyDirectory(target)) {
                throw new RecoveryRequiredException(operation.operationId());
            }
            Files.delete(target);
            forceVaultDirectories(target.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private void applyPathChange(DirectoryPathChangeOperation operation) {
        Path source = operation.sourcePath().resolveUnder(dataDirectories.vault());
        Path destination = operation.destinationPath().resolveUnder(dataDirectories.vault());
        try {
            if (!Files.exists(source)) {
                if (Files.isDirectory(destination) && isEmptyDirectory(destination)) {
                    return;
                }
                throw new RecoveryRequiredException(operation.operationId());
            }
            if (!Files.isDirectory(source) || !isEmptyDirectory(source) || Files.exists(destination)) {
                throw new RecoveryRequiredException(operation.operationId());
            }
            Files.createDirectories(destination.getParent());
            Files.move(source, destination, StandardCopyOption.ATOMIC_MOVE);
            forceVaultDirectories(source.getParent());
            forceVaultDirectories(destination.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private OperationResult finalizeCreate(DirectoryCreateOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = nextRevision(transaction);
            transaction.insertInto(PATH_STATE)
                    .columns(PATH_STATE.PATH, PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION)
                    .values(operation.path().value(), "DIRECTORY", "PRESENT", revision)
                    .execute();
            insertChange(transaction, revision, operation.operationId(), "CREATE", operation.clientId(), null, null);
            insertEffect(transaction, revision, 0, operation.path().value(), "DIRECTORY", "PRESENT");
            markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private OperationResult finalizeDelete(DirectoryDeleteOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = nextRevision(transaction);
            int updated = transaction.update(PATH_STATE)
                    .set(PATH_STATE.STATE, "DELETED")
                    .set(PATH_STATE.LATEST_REVISION, revision)
                    .setNull(PATH_STATE.CONTENT_HASH)
                    .setNull(PATH_STATE.SIZE)
                    .setNull(PATH_STATE.LAST_CONTENT_HASH)
                    .where(PATH_STATE.PATH.eq(operation.path().value()))
                    .and(PATH_STATE.ENTRY_TYPE.eq("DIRECTORY"))
                    .and(PATH_STATE.STATE.eq("PRESENT"))
                    .execute();
            if (updated != 1) {
                throw new IllegalStateException("Directory delete state could not be finalized");
            }
            insertChange(transaction, revision, operation.operationId(), "DELETE", operation.clientId(), null, null);
            insertEffect(transaction, revision, 0, operation.path().value(), "DIRECTORY", "DELETED");
            markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private OperationResult finalizePathChange(DirectoryPathChangeOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = nextRevision(transaction);
            int deleted = transaction.update(PATH_STATE)
                    .set(PATH_STATE.STATE, "DELETED")
                    .set(PATH_STATE.LATEST_REVISION, revision)
                    .setNull(PATH_STATE.CONTENT_HASH)
                    .setNull(PATH_STATE.SIZE)
                    .setNull(PATH_STATE.LAST_CONTENT_HASH)
                    .where(PATH_STATE.PATH.eq(operation.sourcePath().value()))
                    .and(PATH_STATE.ENTRY_TYPE.eq("DIRECTORY"))
                    .and(PATH_STATE.STATE.eq("PRESENT"))
                    .execute();
            if (deleted != 1) {
                throw new IllegalStateException("Directory path-change source could not be finalized");
            }
            transaction.insertInto(PATH_STATE)
                    .columns(PATH_STATE.PATH, PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION)
                    .values(operation.destinationPath().value(), "DIRECTORY", "PRESENT", revision)
                    .execute();
            insertChange(
                    transaction,
                    revision,
                    operation.operationId(),
                    operation.type().name(),
                    operation.clientId(),
                    operation.sourcePath().value(),
                    operation.destinationPath().value());
            insertEffect(transaction, revision, 0, operation.sourcePath().value(), "DIRECTORY", "DELETED");
            insertEffect(transaction, revision, 1, operation.destinationPath().value(), "DIRECTORY", "PRESENT");
            markCommitted(transaction, operation.operationId(), revision);
            return new OperationResult(operation.operationId(), revision, false);
        });
    }

    private static void insertPreparedOperation(
            DSLContext transaction,
            String operationId,
            String clientId,
            String operationType,
            String requestDigest) {
        transaction.insertInto(OPERATIONS)
                .columns(
                        OPERATIONS.OPERATION_ID,
                        OPERATIONS.ACTOR_CLIENT_ID,
                        OPERATIONS.OPERATION_TYPE,
                        OPERATIONS.REQUEST_DIGEST,
                        OPERATIONS.STATUS,
                        OPERATIONS.CREATED_AT)
                .values(operationId, clientId, operationType, requestDigest, "PREPARED", Instant.now().toString())
                .execute();
    }

    private static void insertBase(
            DSLContext transaction,
            String operationId,
            int ordinal,
            String path,
            String state,
            Long revision) {
        transaction.insertInto(OPERATION_BASE_CONDITION)
                .columns(
                        OPERATION_BASE_CONDITION.OPERATION_ID,
                        OPERATION_BASE_CONDITION.ORDINAL,
                        OPERATION_BASE_CONDITION.PATH,
                        OPERATION_BASE_CONDITION.EXPECTED_STATE,
                        OPERATION_BASE_CONDITION.EXPECTED_REVISION)
                .values(operationId, ordinal, path, state, revision)
                .execute();
    }

    private static boolean matchesDirectoryBase(org.jooq.Record state, long revision) {
        return state != null
                && "DIRECTORY".equals(state.get(PATH_STATE.ENTRY_TYPE))
                && "PRESENT".equals(state.get(PATH_STATE.STATE))
                && state.get(PATH_STATE.LATEST_REVISION) == revision;
    }

    private void insertChange(
            DSLContext transaction,
            long revision,
            String operationId,
            String type,
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
                .values(revision, operationId, type, "CLIENT", clientId, sourcePath, destinationPath, Instant.now().toString())
                .execute();
    }

    private static void insertEffect(
            DSLContext transaction,
            long revision,
            int ordinal,
            String path,
            String entryType,
            String state) {
        transaction.insertInto(CHANGE_EFFECT)
                .columns(
                        CHANGE_EFFECT.REVISION,
                        CHANGE_EFFECT.ORDINAL,
                        CHANGE_EFFECT.PATH,
                        CHANGE_EFFECT.ENTRY_TYPE,
                        CHANGE_EFFECT.STATE)
                .values(revision, ordinal, path, entryType, state)
                .execute();
    }

    private static void markCommitted(DSLContext transaction, String operationId, long revision) {
        int completed = transaction.update(OPERATIONS)
                .set(OPERATIONS.STATUS, "COMMITTED")
                .set(OPERATIONS.RESULT_REVISION, revision)
                .set(OPERATIONS.COMPLETED_AT, Instant.now().toString())
                .where(OPERATIONS.OPERATION_ID.eq(operationId).and(OPERATIONS.STATUS.eq("PREPARED")))
                .execute();
        if (completed != 1) {
            throw new IllegalStateException("Prepared directory operation could not be finalized: " + operationId);
        }
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

    private static void requireMatchingDigest(String operationId, String expected, String actual) {
        if (!expected.equals(actual)) {
            throw new OperationIdReuseException(operationId);
        }
    }

    private static String requestDigest(DirectoryCreateOperation operation) {
        return ContentHash.calculateUtf8(String.join(
                "\u0000", operation.operationId(), operation.clientId(), operation.path().value(), "UNKNOWN", "DIRECTORY", "CREATE"));
    }

    private static String requestDigest(DirectoryDeleteOperation operation) {
        return ContentHash.calculateUtf8(String.join(
                "\u0000",
                operation.operationId(),
                operation.clientId(),
                operation.path().value(),
                Long.toString(operation.baseRevision()),
                "DIRECTORY",
                "DELETE"));
    }

    private static String requestDigest(DirectoryPathChangeOperation operation) {
        return ContentHash.calculateUtf8(String.join(
                "\u0000",
                operation.operationId(),
                operation.clientId(),
                operation.sourcePath().value(),
                operation.destinationPath().value(),
                Long.toString(operation.sourceBaseRevision()),
                "UNKNOWN",
                "DIRECTORY",
                operation.type().name()));
    }

    private static boolean isEmptyDirectory(Path directory) throws IOException {
        try (var entries = Files.list(directory)) {
            return entries.findAny().isEmpty();
        }
    }

    private void ensureEmptyDirectory(String operationId, SyncPath path, String message) {
        try {
            Path target = path.resolveUnder(dataDirectories.vault());
            if (!Files.isDirectory(target) || !isEmptyDirectory(target)) {
                throw new BaseStateMismatchException(message);
            }
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operationId, exception);
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
