package io.vaultdatum.server.sync;

public record CreateOperation(
        String operationId,
        String clientId,
        SyncPath path,
        CreateBase base,
        String contentHash,
        long size) {
}
