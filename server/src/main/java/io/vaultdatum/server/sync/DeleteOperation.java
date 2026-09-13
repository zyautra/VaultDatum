package io.vaultdatum.server.sync;

public record DeleteOperation(
        String operationId,
        String clientId,
        SyncPath path,
        PresentBase base) {
}
