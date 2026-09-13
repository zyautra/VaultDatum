package io.vaultdatum.server.sync;

public final class CreateConflictException extends RuntimeException {

    public CreateConflictException(String message) {
        super(message);
    }
}
