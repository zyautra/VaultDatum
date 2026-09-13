package io.vaultdatum.server.sync;

public record CreateOperationResult(String operationId, long resultRevision, boolean replayed) {
}
