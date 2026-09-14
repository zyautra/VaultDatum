package io.vaultdatum.server.sync;

public record DirectoryPathChangeOperation(
        String operationId,
        String clientId,
        PathChangeType type,
        SyncPath sourcePath,
        SyncPath destinationPath,
        long sourceBaseRevision) {
}
