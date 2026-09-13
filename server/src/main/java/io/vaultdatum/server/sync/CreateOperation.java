package io.vaultdatum.server.sync;

public record CreateOperation(
        String operationId,
        String clientId,
        SyncPath path,
        String contentHash,
        long size) {
}
