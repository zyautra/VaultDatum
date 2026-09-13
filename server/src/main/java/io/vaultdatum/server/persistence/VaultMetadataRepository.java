package io.vaultdatum.server.persistence;

import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;
import org.jooq.Field;
import org.jooq.Record;
import org.jooq.Table;
import org.jooq.impl.DSL;

import java.util.UUID;

@ApplicationScoped
public final class VaultMetadataRepository {

    private static final Table<Record> VAULT_METADATA = DSL.table(DSL.name("vault_metadata"));

    private static final Field<Integer> ID = DSL.field(DSL.name("id"), Integer.class);

    private static final Field<String> VAULT_ID = DSL.field(DSL.name("vault_id"), String.class);

    private static final Field<Long> CURRENT_REVISION = DSL.field(DSL.name("current_revision"), Long.class);

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
                    .columns(ID, VAULT_ID, CURRENT_REVISION)
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
        Record record = context.select(VAULT_ID, CURRENT_REVISION)
                .from(VAULT_METADATA)
                .where(ID.eq(1))
                .fetchOne();

        if (record == null) {
            return null;
        }

        return new VaultMetadata(record.get(VAULT_ID), record.get(CURRENT_REVISION));
    }
}
