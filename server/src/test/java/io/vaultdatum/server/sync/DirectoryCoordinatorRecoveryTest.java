package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DIRECTORY_CREATE;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DIRECTORY_DELETE;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DIRECTORY_PATH_CHANGE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.quarkus.test.junit.QuarkusTest;
import io.vaultdatum.server.config.DataDirectories;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;

@QuarkusTest
class DirectoryCoordinatorRecoveryTest {

    private static final String CLIENT_ID = "directory-recovery-client";

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    DirectoryCoordinator directoryCoordinator;

    @Test
    void recoversPreparedDirectoryOperationsBeforeAndAfterFilesystemApply() throws IOException {
        String createPath = path("create");
        String createId = operationId();
        insertPreparedCreate(createId, createPath);

        directoryCoordinator.recoverPreparedDirectories();

        assertTrue(Files.isDirectory(vaultPath(createPath)));
        assertCommittedAfter(createId, 0);

        String deletePath = path("delete");
        long deleteBaseRevision = directoryCoordinator.create(new DirectoryCreateOperation(
                operationId(), CLIENT_ID, SyncPath.parse(deletePath))).resultRevision();
        Files.delete(vaultPath(deletePath));
        String deleteId = operationId();
        insertPreparedDelete(deleteId, deletePath, deleteBaseRevision);

        directoryCoordinator.recoverPreparedDirectories();

        assertFalse(Files.exists(vaultPath(deletePath)));
        assertCommittedAfter(deleteId, deleteBaseRevision);

        String sourcePath = path("rename-source");
        String destinationPath = path("rename-destination");
        long sourceBaseRevision = directoryCoordinator.create(new DirectoryCreateOperation(
                operationId(), CLIENT_ID, SyncPath.parse(sourcePath))).resultRevision();
        String renameId = operationId();
        insertPreparedPathChange(
                renameId,
                PathChangeType.RENAME,
                sourcePath,
                destinationPath,
                sourceBaseRevision);

        directoryCoordinator.recoverPreparedDirectories();

        assertFalse(Files.exists(vaultPath(sourcePath)));
        assertTrue(Files.isDirectory(vaultPath(destinationPath)));
        assertCommittedAfter(renameId, sourceBaseRevision);
    }

    private void insertPreparedCreate(String operationId, String path) {
        String digest = ContentHash.calculateUtf8(String.join(
                "\u0000", operationId, CLIENT_ID, path, "UNKNOWN", "DIRECTORY", "CREATE"));
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            insertPreparedOperation(transaction, operationId, "CREATE", digest);
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE)
                    .values(operationId, 0, path, "UNKNOWN")
                    .execute();
            transaction.insertInto(OPERATION_DIRECTORY_CREATE)
                    .columns(OPERATION_DIRECTORY_CREATE.OPERATION_ID, OPERATION_DIRECTORY_CREATE.PATH)
                    .values(operationId, path)
                    .execute();
        });
    }

    private void insertPreparedDelete(String operationId, String path, long baseRevision) {
        String digest = ContentHash.calculateUtf8(String.join(
                "\u0000",
                operationId,
                CLIENT_ID,
                path,
                Long.toString(baseRevision),
                "DIRECTORY",
                "DELETE"));
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            insertPreparedOperation(transaction, operationId, "DELETE", digest);
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE,
                            OPERATION_BASE_CONDITION.EXPECTED_REVISION)
                    .values(operationId, 0, path, "PRESENT", baseRevision)
                    .execute();
            transaction.insertInto(OPERATION_DIRECTORY_DELETE)
                    .columns(OPERATION_DIRECTORY_DELETE.OPERATION_ID, OPERATION_DIRECTORY_DELETE.PATH)
                    .values(operationId, path)
                    .execute();
        });
    }

    private void insertPreparedPathChange(
            String operationId,
            PathChangeType type,
            String sourcePath,
            String destinationPath,
            long sourceBaseRevision) {
        String digest = ContentHash.calculateUtf8(String.join(
                "\u0000",
                operationId,
                CLIENT_ID,
                sourcePath,
                destinationPath,
                Long.toString(sourceBaseRevision),
                "UNKNOWN",
                "DIRECTORY",
                type.name()));
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            insertPreparedOperation(transaction, operationId, type.name(), digest);
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE,
                            OPERATION_BASE_CONDITION.EXPECTED_REVISION)
                    .values(operationId, 0, sourcePath, "PRESENT", sourceBaseRevision)
                    .execute();
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE)
                    .values(operationId, 1, destinationPath, "UNKNOWN")
                    .execute();
            transaction.insertInto(OPERATION_DIRECTORY_PATH_CHANGE)
                    .columns(
                            OPERATION_DIRECTORY_PATH_CHANGE.OPERATION_ID,
                            OPERATION_DIRECTORY_PATH_CHANGE.SOURCE_PATH,
                            OPERATION_DIRECTORY_PATH_CHANGE.DESTINATION_PATH)
                    .values(operationId, sourcePath, destinationPath)
                    .execute();
        });
    }

    private void insertPreparedOperation(
            DSLContext transaction,
            String operationId,
            String type,
            String digest) {
        transaction.insertInto(OPERATIONS)
                .columns(
                        OPERATIONS.OPERATION_ID,
                        OPERATIONS.ACTOR_CLIENT_ID,
                        OPERATIONS.OPERATION_TYPE,
                        OPERATIONS.REQUEST_DIGEST,
                        OPERATIONS.STATUS,
                        OPERATIONS.CREATED_AT)
                .values(operationId, CLIENT_ID, type, digest, "PREPARED", Instant.now().toString())
                .execute();
    }

    private void assertCommittedAfter(String operationId, long baseRevision) {
        var record = dsl.select(OPERATIONS.STATUS, OPERATIONS.RESULT_REVISION)
                .from(OPERATIONS)
                .where(OPERATIONS.OPERATION_ID.eq(operationId))
                .fetchSingle();
        assertEquals("COMMITTED", record.get(OPERATIONS.STATUS));
        assertTrue(record.get(OPERATIONS.RESULT_REVISION) > baseRevision);
    }

    private Path vaultPath(String path) {
        return dataDirectories.vault().resolve(path);
    }

    private static String path(String operation) {
        return "directory-recovery/" + operation + "-" + UUID.randomUUID();
    }

    private static String operationId() {
        return "OP-directory-recovery-" + UUID.randomUUID();
    }
}
