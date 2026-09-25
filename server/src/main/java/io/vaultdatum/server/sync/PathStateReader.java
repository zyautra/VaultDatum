package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;

@ApplicationScoped
public final class PathStateReader {

    private final DSLContext dsl;

    public PathStateReader(DSLContext dsl) {
        this.dsl = dsl;
    }

    public PathState read(SyncPath path) {
        var record = dsl.select(
                        PATH_STATE.ENTRY_TYPE,
                        PATH_STATE.STATE,
                        PATH_STATE.LATEST_REVISION,
                        PATH_STATE.CONTENT_HASH,
                        PATH_STATE.SIZE)
                .from(PATH_STATE)
                .where(PATH_STATE.PATH.eq(path.value()))
                .fetchOne();
        if (record == null) {
            return PathState.unknown(path.value());
        }

        return new PathState(
                path.value(),
                record.get(PATH_STATE.ENTRY_TYPE),
                record.get(PATH_STATE.STATE),
                record.get(PATH_STATE.LATEST_REVISION),
                record.get(PATH_STATE.CONTENT_HASH),
                record.get(PATH_STATE.SIZE));
    }

    public record PathState(
            String path,
            String entryType,
            String state,
            Long revision,
            String contentHash,
            Long size) {

        private static PathState unknown(String path) {
            return new PathState(path, null, "UNKNOWN", null, null, null);
        }
    }
}
