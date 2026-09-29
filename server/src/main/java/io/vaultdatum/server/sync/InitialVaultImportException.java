package io.vaultdatum.server.sync;

/**
 * Signals that a requested initial Vault import was refused or failed without recording anything.
 */
public final class InitialVaultImportException extends RuntimeException {

    public InitialVaultImportException(String message) {
        super(message);
    }

    public InitialVaultImportException(String message, Throwable cause) {
        super(message, cause);
    }
}
