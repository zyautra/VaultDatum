package io.vaultdatum.server.sync;

public record DirectoryCreateOperation(
        String operationId,
        String clientId,
        SyncPath path) {
}
