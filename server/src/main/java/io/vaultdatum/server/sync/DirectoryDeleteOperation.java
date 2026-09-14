package io.vaultdatum.server.sync;

public record DirectoryDeleteOperation(
        String operationId,
        String clientId,
        SyncPath path,
        long baseRevision) {
}
