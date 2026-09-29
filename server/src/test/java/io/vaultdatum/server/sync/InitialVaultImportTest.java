package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.TestProfile;
import jakarta.inject.Inject;
import org.jooq.DSLContext;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

@QuarkusTest
@TestProfile(InitialImportTestProfile.class)
class InitialVaultImportTest {

    @Inject
    DSLContext dsl;

    @Inject
    InitialVaultImport initialVaultImport;

    @Inject
    VaultIntegrityScan integrityScan;

    @Test
    void importsCopiedVaultAtStartupAsServerExternalCreates() {
        assertEquals(4L, dsl.select(VAULT_METADATA.CURRENT_REVISION)
                .from(VAULT_METADATA)
                .fetchSingle(VAULT_METADATA.CURRENT_REVISION));
        assertEquals(
                List.of("attachments/empty", "attachments/image.png", "notes/first.md", "notes/nested/second.md"),
                dsl.select(PATH_STATE.PATH).from(PATH_STATE).orderBy(PATH_STATE.LATEST_REVISION).fetch(PATH_STATE.PATH));
        assertEquals("DIRECTORY", dsl.select(PATH_STATE.ENTRY_TYPE)
                .from(PATH_STATE)
                .where(PATH_STATE.PATH.eq("attachments/empty"))
                .fetchSingle(PATH_STATE.ENTRY_TYPE));
        assertEquals(
                ContentHash.calculate("First note".getBytes(StandardCharsets.UTF_8)),
                dsl.select(PATH_STATE.CONTENT_HASH)
                        .from(PATH_STATE)
                        .where(PATH_STATE.PATH.eq("notes/first.md"))
                        .fetchSingle(PATH_STATE.CONTENT_HASH));
        assertEquals(List.of("SERVER_EXTERNAL"), dsl.selectDistinct(CHANGE_JOURNAL.ACTOR_TYPE)
                .from(CHANGE_JOURNAL)
                .fetch(CHANGE_JOURNAL.ACTOR_TYPE));
        assertEquals(List.of(), integrityScan.scan());
    }

    @Test
    void refusesToImportAgainOnceTheJournalHasChanges() {
        assertThrows(InitialVaultImportException.class, initialVaultImport::run);
    }
}
