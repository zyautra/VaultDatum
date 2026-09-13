package io.vaultdatum.server.sync;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static io.vaultdatum.server.jooq.Tables.OPERATION_BASE_CONDITION;
import static io.vaultdatum.server.jooq.Tables.OPERATION_CREATE;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;

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
import java.time.Instant;
import java.util.UUID;

@QuarkusTest
class CreateCoordinatorRecoveryTest {

    @Inject
    DataDirectories dataDirectories;

    @Inject
    DSLContext dsl;

    @Inject
    CreateCoordinator createCoordinator;

    @Test
    void appliesStagedPreparedCreateAndFinalizesIt() throws IOException {
        PreparedCreate prepared = preparedCreate();
        Path stagedContent = dataDirectories.staging().resolve(prepared.stagingReference());
        Files.writeString(stagedContent, prepared.content(), StandardCharsets.UTF_8);
        insertPrepared(prepared);

        createCoordinator.recoverPreparedCreates();

        assertEquals(prepared.content(), Files.readString(dataDirectories.vault().resolve(prepared.path())));
        assertFalse(Files.exists(stagedContent));
        assertEquals("COMMITTED", operationStatus(prepared.operationId()));
    }

    @Test
    void finalizesPreparedCreateWhenFilesystemWasAlreadyApplied() throws IOException {
        PreparedCreate prepared = preparedCreate();
        Path target = dataDirectories.vault().resolve(prepared.path());
        Files.createDirectories(target.getParent());
        Files.writeString(target, prepared.content(), StandardCharsets.UTF_8);
        insertPrepared(prepared);

        createCoordinator.recoverPreparedCreates();

        assertEquals(prepared.content(), Files.readString(target));
        assertEquals("COMMITTED", operationStatus(prepared.operationId()));
    }

    private PreparedCreate preparedCreate() {
        String operationId = "OP-recovery-" + UUID.randomUUID();
        String path = "recovery/" + UUID.randomUUID() + ".md";
        String content = "Recovered content";
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        String stagingReference = "recovery-" + UUID.randomUUID() + ".tmp";

        return new PreparedCreate(operationId, path, content, ContentHash.calculate(bytes), bytes.length, stagingReference);
    }

    private void insertPrepared(PreparedCreate prepared) {
        String requestDigest = ContentHash.calculateUtf8(String.join("\u0000",
                prepared.operationId(), "recovery-client", prepared.path(), "UNKNOWN", "", prepared.contentHash(),
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
                            OPERATIONS.CREATED_AT)
                    .values(
                            prepared.operationId(),
                            "recovery-client",
                            "CREATE",
                            requestDigest,
                            "PREPARED",
                            prepared.stagingReference(),
                            Instant.now().toString())
                    .execute();
            transaction.insertInto(OPERATION_BASE_CONDITION)
                    .columns(
                            OPERATION_BASE_CONDITION.OPERATION_ID,
                            OPERATION_BASE_CONDITION.ORDINAL,
                            OPERATION_BASE_CONDITION.PATH,
                            OPERATION_BASE_CONDITION.EXPECTED_STATE)
                    .values(prepared.operationId(), 0, prepared.path(), "UNKNOWN")
                    .execute();
            transaction.insertInto(OPERATION_CREATE)
                    .columns(
                            OPERATION_CREATE.OPERATION_ID,
                            OPERATION_CREATE.PATH,
                            OPERATION_CREATE.CONTENT_HASH,
                            OPERATION_CREATE.SIZE)
                    .values(
                            prepared.operationId(),
                            prepared.path(),
                            prepared.contentHash(),
                            prepared.size())
                    .execute();
        });
    }

    private String operationStatus(String operationId) {
        return dsl.select(OPERATIONS.STATUS)
                .from(OPERATIONS)
                .where(OPERATIONS.OPERATION_ID.eq(operationId))
                .fetchSingle(OPERATIONS.STATUS);
    }

    private record PreparedCreate(
            String operationId,
            String path,
            String content,
            String contentHash,
            long size,
            String stagingReference) {
    }
}
