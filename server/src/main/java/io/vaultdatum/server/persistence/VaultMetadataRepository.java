package io.vaultdatum.server.persistence;

import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

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

    public VaultMetadata current() {
        VaultMetadata metadata = find(dsl);

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
