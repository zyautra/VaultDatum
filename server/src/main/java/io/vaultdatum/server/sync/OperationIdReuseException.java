package io.vaultdatum.server.sync;

public final class OperationIdReuseException extends RuntimeException {

    public OperationIdReuseException(String operationId) {
        super("Operation ID was already used for a different request: " + operationId);
    }
}
