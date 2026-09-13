package io.vaultdatum.server.sync;

public record OperationResult(String operationId, long resultRevision, boolean replayed) {
}
