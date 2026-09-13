package io.vaultdatum.server.sync;

public record RenameOperation(
        String operationId,
        String clientId,
        SyncPath sourcePath,
        SyncPath destinationPath,
        PresentBase sourceBase) {
}
