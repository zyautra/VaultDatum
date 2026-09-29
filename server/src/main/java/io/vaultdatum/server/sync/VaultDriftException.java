package io.vaultdatum.server.sync;

/**
 * Signals that the Vault filesystem no longer matches the recorded path state.
 *
 * <p>The mutation is rejected before a prepared operation is recorded, so no
 * recovery work is created. An operator must resolve the drift.</p>
 */
public final class VaultDriftException extends RuntimeException {

    public VaultDriftException(String path) {
        super("The authoritative Vault differs from its recorded state at " + path);
    }

    public VaultDriftException(String path, Throwable cause) {
        super("The authoritative Vault differs from its recorded state at " + path, cause);
    }
}
