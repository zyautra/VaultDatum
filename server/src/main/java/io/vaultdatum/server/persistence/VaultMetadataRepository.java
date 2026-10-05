package io.vaultdatum.server.persistence;

import static io.vaultdatum.server.jooq.Tables.MANIFEST;
import static io.vaultdatum.server.jooq.Tables.MANIFEST_ENTRY;
import static io.vaultdatum.server.jooq.Tables.PREVIOUS_VAULT;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

@ApplicationScoped
public final class VaultMetadataRepository {

    private final DSLContext dsl;

    public VaultMetadataRepository(DSLContext dsl) {
        this.dsl = dsl;
    }

    public VaultMetadata initialize() {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            VaultMetadata existing = find(transaction);

            if (existing != null) {
                return existing;
            }

            VaultMetadata created = new VaultMetadata("V-" + UUID.randomUUID(), 0);
            transaction.insertInto(VAULT_METADATA)
                    .columns(VAULT_METADATA.ID, VAULT_METADATA.VAULT_ID, VAULT_METADATA.CURRENT_REVISION)
                    .values(1, created.vaultId(), created.currentRevision())
                    .execute();
            return created;
        });
    }

    /**
     * Gives a Vault restored from a Backup a new identity.
     *
     * <p>The restored journal reuses revision numbers that clients may already
     * have seen under the old Vault ID. A new Vault ID makes those clients stop
     * using their cursor; the old ID is kept so they can recognize the restored
     * Vault. Manifests created under the old ID are discarded.</p>
     */
    public VaultMetadata replaceAfterRestore(String restoredBackupCreatedAt) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            VaultMetadata restored = current(transaction);
            VaultMetadata replaced = new VaultMetadata("V-" + UUID.randomUUID(), restored.currentRevision());

            transaction.insertInto(PREVIOUS_VAULT)
                    .columns(PREVIOUS_VAULT.VAULT_ID, PREVIOUS_VAULT.REPLACED_AT,
                            PREVIOUS_VAULT.RESTORED_BACKUP_CREATED_AT)
                    .values(restored.vaultId(), Instant.now().truncatedTo(ChronoUnit.SECONDS).toString(),
                            restoredBackupCreatedAt)
                    .execute();
            transaction.update(VAULT_METADATA)
                    .set(VAULT_METADATA.VAULT_ID, replaced.vaultId())
                    .where(VAULT_METADATA.ID.eq(1))
                    .execute();
            transaction.deleteFrom(MANIFEST_ENTRY).execute();
            transaction.deleteFrom(MANIFEST).execute();
            return replaced;
        });
    }

    /**
     * Returns the Vault IDs this Vault had before it was restored from a Backup, oldest first.
     */
    public List<String> previousVaultIds() {
        return dsl.select(PREVIOUS_VAULT.VAULT_ID)
                .from(PREVIOUS_VAULT)
                .orderBy(PREVIOUS_VAULT.REPLACED_AT, PREVIOUS_VAULT.VAULT_ID)
                .fetch(PREVIOUS_VAULT.VAULT_ID);
    }

    public VaultMetadata current() {
        return current(dsl);
    }

    public VaultMetadata current(DSLContext context) {
        VaultMetadata metadata = find(context);

        if (metadata == null) {
            throw new IllegalStateException("Vault metadata has not been initialized");
        }

        return metadata;
    }

    private VaultMetadata find(DSLContext context) {
        var record = context.select(VAULT_METADATA.VAULT_ID, VAULT_METADATA.CURRENT_REVISION)
                .from(VAULT_METADATA)
                .where(VAULT_METADATA.ID.eq(1))
                .fetchOne();

        if (record == null) {
            return null;
        }

        return new VaultMetadata(record.get(VAULT_METADATA.VAULT_ID), record.get(VAULT_METADATA.CURRENT_REVISION));
    }
}
