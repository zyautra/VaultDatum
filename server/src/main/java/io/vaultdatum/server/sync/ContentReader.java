package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.PATH_STATE;

import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.jooq.DSLContext;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

@ApplicationScoped
public final class ContentReader {

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    public ContentReader(DataDirectories dataDirectories, DSLContext dsl) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
    }

    public Content read(SyncPath path, long revision, String contentHash) {
        var state = dsl.select(PATH_STATE.LATEST_REVISION, PATH_STATE.CONTENT_HASH, PATH_STATE.SIZE)
                .from(PATH_STATE)
                .where(PATH_STATE.PATH.eq(path.value()))
                .and(PATH_STATE.ENTRY_TYPE.eq("FILE"))
                .and(PATH_STATE.STATE.eq("PRESENT"))
                .fetchOne();

        if (state == null || state.get(PATH_STATE.LATEST_REVISION) != revision
                || !contentHash.equals(state.get(PATH_STATE.CONTENT_HASH))) {
            throw new StateChangedException(path.value());
        }

        Path content = path.resolveUnder(dataDirectories.vault());
        try {
            if (!Files.isRegularFile(content)) {
                throw new StateChangedException(path.value());
            }

            ContentHash.HashedContent actual = ContentHash.calculate(content);
            if (!contentHash.equals(actual.value()) || actual.size() != state.get(PATH_STATE.SIZE)) {
                throw new StateChangedException(path.value());
            }

            return new Content(content, actual.size());
        } catch (IOException exception) {
            throw new StateChangedException(path.value(), exception);
        }
    }

    public record Content(Path path, long size) {
    }
}
