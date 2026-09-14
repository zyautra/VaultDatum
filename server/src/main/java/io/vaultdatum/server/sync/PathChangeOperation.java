package io.vaultdatum.server.sync;

public record PathChangeOperation(
        String operationId,
        String clientId,
        PathChangeType type,
        SyncPath sourcePath,
        SyncPath destinationPath,
        PresentBase sourceBase) {
}
