package io.vaultdatum.server.sync;

/**
 * Signals that the content for a hash is neither kept in history nor present in the Vault.
 */
public final class ContentNotRetainedException extends RuntimeException {

    public ContentNotRetainedException(String contentHash) {
        super("The content is no longer kept: " + contentHash);
    }
}
