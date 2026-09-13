package io.vaultdatum.server.sync;

public final class StateChangedException extends RuntimeException {

    public StateChangedException(String path) {
        super("The current server state no longer matches the requested content: " + path);
    }

    public StateChangedException(String path, Throwable cause) {
        super("The current server state no longer matches the requested content: " + path, cause);
    }
}
