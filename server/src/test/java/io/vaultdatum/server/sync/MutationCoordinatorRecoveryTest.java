package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_DELETE;
import static io.vaultdatum.server.jooq.Tables.OPERATION_MODIFY;
import static io.vaultdatum.server.jooq.Tables.OPERATION_RENAME;
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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.UUID;

@QuarkusTest
class MutationCoordinatorRecoveryTest {

    private static final String CLIENT_ID = "recovery-client";

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    CreateCoordinator createCoordinator;

    @Inject
    ModifyCoordinator modifyCoordinator;

    @Inject
    DeleteCoordinator deleteCoordinator;

    @Inject
    RenameCoordinator renameCoordinator;

    @Test
    void recoversPreparedModifyBeforeAndAfterFilesystemApply() throws IOException {
        String beforePath = path("modify-before");
        String beforeContent = "Modify source before filesystem apply";
        long beforeRevision = createSource(beforePath, beforeContent);
        PreparedModify before = preparedModify(beforePath, beforeRevision, beforeContent, "Modified after recovery");
        Path staged = writeStaged(before.stagingReference(), before.content());
        insertPreparedModify(before);

        modifyCoordinator.recoverPreparedModifies();

        assertEquals(before.content(), Files.readString(vaultPath(before.path())));
        assertFalse(Files.exists(staged));
        assertFalse(Files.exists(modifyRecoveryPath(before.operationId())));
        assertCommittedAfter(before.operationId(), beforeRevision);

        String afterPath = path("modify-after");
        String afterBaseContent = "Modify source before crash";
        long afterRevision = createSource(afterPath, afterBaseContent);
        PreparedModify after = preparedModify(afterPath, afterRevision, afterBaseContent, "Modified before recovery");
        Path target = vaultPath(after.path());
        Path recovery = modifyRecoveryPath(after.operationId());
        Files.move(target, recovery, StandardCopyOption.ATOMIC_MOVE);
        Files.writeString(target, after.content(), StandardCharsets.UTF_8);
        insertPreparedModify(after);

        modifyCoordinator.recoverPreparedModifies();

        assertEquals(after.content(), Files.readString(target));
        assertFalse(Files.exists(recovery));
        assertCommittedAfter(after.operationId(), afterRevision);
    }

    @Test
    void recoversPreparedDeleteBeforeAndAfterFilesystemApply() throws IOException {
        String beforePath = path("delete-before");
        String beforeContent = "Delete source before filesystem apply";
        long beforeRevision = createSource(beforePath, beforeContent);
        PreparedDelete before = preparedDelete(beforePath, beforeRevision, beforeContent);
        insertPreparedDelete(before);

        deleteCoordinator.recoverPreparedDeletes();

        assertFalse(Files.exists(vaultPath(before.path())));
        assertFalse(Files.exists(deleteRecoveryPath(before.operationId())));
        assertCommittedAfter(before.operationId(), beforeRevision);

        String afterPath = path("delete-after");
        String afterContent = "Delete source before crash";
        long afterRevision = createSource(afterPath, afterContent);
        PreparedDelete after = preparedDelete(afterPath, afterRevision, afterContent);
        Files.move(
                vaultPath(after.path()),
                deleteRecoveryPath(after.operationId()),
                StandardCopyOption.ATOMIC_MOVE);
        insertPreparedDelete(after);

        deleteCoordinator.recoverPreparedDeletes();

        assertFalse(Files.exists(vaultPath(after.path())));
        assertFalse(Files.exists(deleteRecoveryPath(after.operationId())));
        assertCommittedAfter(after.operationId(), afterRevision);
    }

    @Test
    void recoversPreparedRenameBeforeAndAfterFilesystemApply() throws IOException {
        String beforeSource = path("rename-before-source");
        String beforeDestination = path("rename-before-destination");
        String beforeContent = "Rename source before filesystem apply";
        long beforeRevision = createSource(beforeSource, beforeContent);
        PreparedRename before = preparedRename(
                beforeSource, beforeDestination, beforeRevision, beforeContent);
        insertPreparedRename(before);

        renameCoordinator.recoverPreparedRenames();

        assertFalse(Files.exists(vaultPath(before.sourcePath())));
        assertEquals(beforeContent, Files.readString(vaultPath(before.destinationPath())));
        assertCommittedAfter(before.operationId(), beforeRevision);

        String afterSource = path("rename-after-source");
        String afterDestination = path("rename-after-destination");
        String afterContent = "Rename source before crash";
        long afterRevision = createSource(afterSource, afterContent);
        PreparedRename after = preparedRename(
                afterSource, afterDestination, afterRevision, afterContent);
        Files.createDirectories(vaultPath(after.destinationPath()).getParent());
        Files.move(
                vaultPath(after.sourcePath()),
                vaultPath(after.destinationPath()),
                StandardCopyOption.ATOMIC_MOVE);
        insertPreparedRename(after);

        renameCoordinator.recoverPreparedRenames();

        assertFalse(Files.exists(vaultPath(after.sourcePath())));
        assertEquals(afterContent, Files.readString(vaultPath(after.destinationPath())));
        assertCommittedAfter(after.operationId(), afterRevision);
    }

    private long createSource(String path, String content) throws IOException {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        Path staged = Files.createTempFile(dataDirectories.staging(), "seed-", ".tmp");
        Files.write(staged, bytes);
        return createCoordinator.commit(new CreateOperation(
                operationId(),
                CLIENT_ID,
                SyncPath.parse(path),
                UnknownCreateBase.INSTANCE,
                ContentHash.calculate(bytes),
                bytes.length), staged).resultRevision();
    }

    private PreparedModify preparedModify(
            String path,
            long baseRevision,
            String baseContent,
            String content) {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        return new PreparedModify(
                operationId(),
                path,
                baseRevision,
                ContentHash.calculate(baseContent.getBytes(StandardCharsets.UTF_8)),
                content,
                ContentHash.calculate(bytes),
                bytes.length,
                "modify-" + UUID.randomUUID() + ".tmp");
    }

    private PreparedDelete preparedDelete(String path, long baseRevision, String baseContent) {
        return new PreparedDelete(
                operationId(),
                path,
                baseRevision,
                ContentHash.calculate(baseContent.getBytes(StandardCharsets.UTF_8)));
    }

    private PreparedRename preparedRename(
            String sourcePath,
            String destinationPath,
            long sourceRevision,
            String content) {
        return new PreparedRename(
                operationId(),
                sourcePath,
                destinationPath,
                sourceRevision,
                ContentHash.calculate(content.getBytes(StandardCharsets.UTF_8)));
    }

    private Path writeStaged(String reference, String content) throws IOException {
        Path staged = dataDirectories.staging().resolve(reference);
        Files.writeString(staged, content, StandardCharsets.UTF_8);
        return staged;
    }

    private void insertPreparedModify(PreparedModify prepared) {
        String requestDigest = ContentHash.calculateUtf8(String.join(
                "\u0000",
                prepared.operationId(),
                CLIENT_ID,
                prepared.path(),
                Long.toString(prepared.baseRevision()),
                prepared.baseHash(),
                prepared.contentHash(),
                Long.toString(prepared.size())));
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
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
                            prepared.operationId(),
                            CLIENT_ID,
                            "MODIFY",
                            requestDigest,
                            "PREPARED",
                            prepared.stagingReference(),
                            "modify-" + prepared.operationId() + ".bak",
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
                            prepared.operationId(),
                            0,
                            prepared.path(),
                            "PRESENT",
                            prepared.baseRevision(),
                            prepared.baseHash())
                    .execute();
            transaction.insertInto(OPERATION_MODIFY)
                    .columns(
                            OPERATION_MODIFY.OPERATION_ID,
                            OPERATION_MODIFY.PATH,
                            OPERATION_MODIFY.CONTENT_HASH,
                            OPERATION_MODIFY.SIZE)
                    .values(
                            prepared.operationId(),
                            prepared.path(),
                            prepared.contentHash(),
                            prepared.size())
                    .execute();
        });
    }

    private void insertPreparedDelete(PreparedDelete prepared) {
        String requestDigest = ContentHash.calculateUtf8(String.join(
                "\u0000",
                prepared.operationId(),
                CLIENT_ID,
                prepared.path(),
                Long.toString(prepared.baseRevision()),
                prepared.baseHash()));
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
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
                            prepared.operationId(),
                            CLIENT_ID,
                            "DELETE",
                            requestDigest,
                            "PREPARED",
                            "delete-" + prepared.operationId() + ".bak",
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
                            prepared.operationId(),
                            0,
                            prepared.path(),
                            "PRESENT",
                            prepared.baseRevision(),
                            prepared.baseHash())
                    .execute();
            transaction.insertInto(OPERATION_DELETE)
                    .columns(OPERATION_DELETE.OPERATION_ID, OPERATION_DELETE.PATH)
                    .values(prepared.operationId(), prepared.path())
                    .execute();
        });
    }

    private void insertPreparedRename(PreparedRename prepared) {
        String requestDigest = ContentHash.calculateUtf8(String.join(
                "\u0000",
                prepared.operationId(),
                CLIENT_ID,
                prepared.sourcePath(),
                prepared.destinationPath(),
                Long.toString(prepared.sourceRevision()),
                prepared.sourceHash(),
                "UNKNOWN"));
        dsl.transaction(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            transaction.insertInto(OPERATIONS)
                    .columns(
                            OPERATIONS.OPERATION_ID,
                            OPERATIONS.ACTOR_CLIENT_ID,
                            OPERATIONS.OPERATION_TYPE,
                            OPERATIONS.REQUEST_DIGEST,
                            OPERATIONS.STATUS,
                            OPERATIONS.CREATED_AT)
                    .values(
                            prepared.operationId(),
                            CLIENT_ID,
                            "RENAME",
                            requestDigest,
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
                            prepared.operationId(),
                            0,
                            prepared.sourcePath(),
                            "PRESENT",
                            prepared.sourceRevision(),
                            prepared.sourceHash())
                    .execute();
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE)
                    .values(prepared.operationId(), 1, prepared.destinationPath(), "UNKNOWN")
                    .execute();
            transaction.insertInto(OPERATION_RENAME)
                    .columns(
                            OPERATION_RENAME.OPERATION_ID,
                            OPERATION_RENAME.SOURCE_PATH,
                            OPERATION_RENAME.DESTINATION_PATH)
                    .values(
                            prepared.operationId(),
                            prepared.sourcePath(),
                            prepared.destinationPath())
                    .execute();
        });
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

    private Path modifyRecoveryPath(String operationId) {
        return dataDirectories.recovery().resolve("modify-" + operationId + ".bak");
    }

    private Path deleteRecoveryPath(String operationId) {
        return dataDirectories.recovery().resolve("delete-" + operationId + ".bak");
    }

    private static String path(String prefix) {
        return "recovery/" + prefix + "-" + UUID.randomUUID() + ".md";
    }

    private static String operationId() {
        return "OP-recovery-" + UUID.randomUUID();
    }

    private record PreparedModify(
            String operationId,
            String path,
            long baseRevision,
            String baseHash,
            String content,
            String contentHash,
            long size,
            String stagingReference) {
    }

    private record PreparedDelete(
            String operationId,
            String path,
            long baseRevision,
            String baseHash) {
    }

    private record PreparedRename(
            String operationId,
            String sourcePath,
            String destinationPath,
            long sourceRevision,
            String sourceHash) {
    }
}
