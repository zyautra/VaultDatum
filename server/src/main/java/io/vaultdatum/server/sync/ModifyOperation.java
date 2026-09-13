package io.vaultdatum.server.sync;

public record ModifyOperation(
        String operationId,
        String clientId,
        SyncPath path,
        PresentBase base,
        String contentHash,
        long size) {
}
