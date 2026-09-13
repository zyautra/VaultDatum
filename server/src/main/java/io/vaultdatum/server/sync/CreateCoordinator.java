package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_EFFECT;
import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_CREATE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import io.vaultdatum.server.config.DataDirectories;
import io.vaultdatum.server.jooq.tables.OperationCreate;
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
public final class CreateCoordinator {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public CreateCoordinator(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public synchronized CreateOperationResult commit(CreateOperation operation, Path stagedContent) {
        CreateOperationResult replayed = existingResult(operation);

        if (replayed != null) {
            return replayed;
        }

        Path normalizedStaging = requireStagedContent(stagedContent);
        ensureTargetIsAbsent(operation);
        forceDirectory(normalizedStaging.getParent());
        prepare(operation, normalizedStaging);
        apply(operation, normalizedStaging);
        return finalize(operation);
    }

    public synchronized void recoverPreparedCreates() {
        Operations operations = OPERATIONS.as("operations");
        OperationCreate operationCreates = OPERATION_CREATE.as("operation_create");
        var preparedOperations = dsl.select(
                        operations.OPERATION_ID,
                        operations.ACTOR_CLIENT_ID,
                        operations.REQUEST_DIGEST,
                        operations.STAGING_REFERENCE,
                        operationCreates.PATH,
                        operationCreates.CONTENT_HASH,
                        operationCreates.SIZE)
                .from(operations)
                .join(operationCreates)
                .on(operationCreates.OPERATION_ID.eq(operations.OPERATION_ID))
                .where(operations.STATUS.eq("PREPARED"))
                .fetch();

        for (var record : preparedOperations) {
            CreateOperation operation = new CreateOperation(
                    record.get(operations.OPERATION_ID),
                    record.get(operations.ACTOR_CLIENT_ID),
                    SyncPath.parse(record.get(operationCreates.PATH)),
                    record.get(operationCreates.CONTENT_HASH),
                    record.get(operationCreates.SIZE));
            String requestDigest = requestDigest(operation);

            if (!requestDigest.equals(record.get(operations.REQUEST_DIGEST))) {
                throw new IllegalStateException("Prepared operation request digest does not match: "
                        + operation.operationId());
            }

            apply(operation, stagingPath(record.get(operations.STAGING_REFERENCE)));
            finalize(operation);
        }
    }

    private CreateOperationResult existingResult(CreateOperation operation) {
        var record = dsl.select(OPERATIONS.STATUS, OPERATIONS.RESULT_REVISION, OPERATIONS.REQUEST_DIGEST)
                .from(OPERATIONS)
                .where(OPERATIONS.OPERATION_ID.eq(operation.operationId()))
                .fetchOne();

        if (record == null) {
            return null;
        }
        if (!requestDigest(operation).equals(record.get(OPERATIONS.REQUEST_DIGEST))) {
            throw new OperationIdReuseException(operation.operationId());
        }
        if (!"COMMITTED".equals(record.get(OPERATIONS.STATUS))) {
            throw new RecoveryRequiredException(operation.operationId());
        }

        return new CreateOperationResult(operation.operationId(), record.get(OPERATIONS.RESULT_REVISION), true);
    }

    private void ensureTargetIsAbsent(CreateOperation operation) {
        Path target = operation.path().resolveUnder(dataDirectories.vault());

        if (Files.exists(target)) {
            throw new CreateConflictException("The create path already exists in the authoritative Vault");
        }
    }

    private void prepare(CreateOperation operation, Path stagedContent) {
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            boolean knownPath = transaction.fetchExists(
                    transaction.selectOne().from(PATH_STATE).where(PATH_STATE.PATH.eq(operation.path().value())));

            if (knownPath) {
                throw new CreateConflictException("The create path is already known to the server");
            }

            transaction.insertInto(OPERATIONS)
                    .columns(
                            OPERATIONS.OPERATION_ID,
                            OPERATIONS.ACTOR_CLIENT_ID,
                            OPERATIONS.OPERATION_TYPE,
                            OPERATIONS.REQUEST_DIGEST,
                            OPERATIONS.STATUS,
                            OPERATIONS.STAGING_REFERENCE,
                            OPERATIONS.CREATED_AT)
                    .values(
                            operation.operationId(),
                            operation.clientId(),
                            "CREATE",
                            requestDigest(operation),
                            "PREPARED",
                            stagedContent.getFileName().toString(),
                            Instant.now().toString())
                    .execute();
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE)
                    .values(operation.operationId(), 0, operation.path().value(), "UNKNOWN")
                    .execute();
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
                if (matches(operation, target)) {
                    return;
                }
                throw new RecoveryRequiredException(operation.operationId());
            }
            if (!Files.isRegularFile(stagedContent)) {
                throw new RecoveryRequiredException(operation.operationId());
            }

            Files.createDirectories(target.getParent());
            Files.move(stagedContent, target, StandardCopyOption.ATOMIC_MOVE);
            forceVaultDirectories(target.getParent());
            forceDirectory(stagedContent.getParent());
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private boolean matches(CreateOperation operation, Path target) {
        try {
            ContentHash.HashedContent actual = ContentHash.calculate(target);
            return operation.contentHash().equals(actual.value()) && operation.size() == actual.size();
        } catch (IOException exception) {
            throw new RecoveryRequiredException(operation.operationId(), exception);
        }
    }

    private CreateOperationResult finalize(CreateOperation operation) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = transaction.select(VAULT_METADATA.CURRENT_REVISION)
                    .from(VAULT_METADATA)
                    .where(VAULT_METADATA.ID.eq(1))
                    .fetchSingle(VAULT_METADATA.CURRENT_REVISION) + 1;

            transaction.update(VAULT_METADATA)
                    .set(VAULT_METADATA.CURRENT_REVISION, revision)
                    .where(VAULT_METADATA.ID.eq(1))
                    .execute();
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
            transaction.insertInto(CHANGE_JOURNAL)
                    .columns(
                            CHANGE_JOURNAL.REVISION,
                            CHANGE_JOURNAL.OPERATION_ID,
                            CHANGE_JOURNAL.CHANGE_TYPE,
                            CHANGE_JOURNAL.ACTOR_TYPE,
                            CHANGE_JOURNAL.ACTOR_CLIENT_ID,
                            CHANGE_JOURNAL.COMMITTED_AT)
                    .values(
                            revision,
                            operation.operationId(),
                            "CREATE",
                            "CLIENT",
                            operation.clientId(),
                            Instant.now().toString())
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
            int updatedOperations = transaction.update(OPERATIONS)
                    .set(OPERATIONS.STATUS, "COMMITTED")
                    .set(OPERATIONS.RESULT_REVISION, revision)
                    .set(OPERATIONS.COMPLETED_AT, Instant.now().toString())
                    .where(OPERATIONS.OPERATION_ID.eq(operation.operationId()).and(OPERATIONS.STATUS.eq("PREPARED")))
                    .execute();

            if (updatedOperations != 1) {
                throw new IllegalStateException("Prepared operation could not be finalized: " + operation.operationId());
            }
            return new CreateOperationResult(operation.operationId(), revision, false);
        });
    }

    private Path stagingPath(String reference) {
        if (reference == null || reference.isBlank()) {
            throw new IllegalStateException("Missing staging reference in operation metadata");
        }

        Path stagedContent = dataDirectories.staging().resolve(reference).normalize();

        if (!stagedContent.getParent().equals(dataDirectories.staging())) {
            throw new IllegalStateException("Invalid staging reference in operation metadata");
        }

        return stagedContent;
    }

    private Path requireStagedContent(Path stagedContent) {
        Path normalizedStaging = stagedContent.toAbsolutePath().normalize();

        if (!normalizedStaging.getParent().equals(dataDirectories.staging()) || !Files.isRegularFile(normalizedStaging)) {
            throw new IllegalArgumentException("Create content must be staged under the server staging directory");
        }

        return normalizedStaging;
    }

    private static String requestDigest(CreateOperation operation) {
        return ContentHash.calculateUtf8(String.join("\u0000",
                operation.operationId(),
                operation.clientId(),
                operation.path().value(),
                operation.contentHash(),
                Long.toString(operation.size())));
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
