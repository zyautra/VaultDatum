package io.vaultdatum.server.sync;

public final class RecoveryRequiredException extends RuntimeException {

    public RecoveryRequiredException(String operationId) {
        super("Operation must be completed by server recovery: " + operationId);
    }

    public RecoveryRequiredException(String operationId, Throwable cause) {
        super("Operation must be completed by server recovery: " + operationId, cause);
    }
}
