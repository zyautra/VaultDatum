package io.vaultdatum.server.persistence;

import jakarta.enterprise.inject.Produces;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javax.sql.DataSource;
import org.jooq.DSLContext;
import org.jooq.SQLDialect;
import org.jooq.impl.DSL;

@Singleton
public final class JooqConfiguration {

    @Inject
    DataSource dataSource;

    @Produces
    @Singleton
    DSLContext dslContext() {
        return DSL.using(dataSource, SQLDialect.SQLITE);
    }
}
