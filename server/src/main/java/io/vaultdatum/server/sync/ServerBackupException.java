package io.vaultdatum.server.sync;

/**
 * The server Backup could not be refreshed or restored.
 */
public final class ServerBackupException extends RuntimeException {

    public ServerBackupException(String message) {
        super(message);
    }

    public ServerBackupException(String message, Throwable cause) {
        super(message, cause);
    }
}
