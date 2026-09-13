package io.vaultdatum.server.sync;

public final class ManifestNotFoundException extends RuntimeException {

    public ManifestNotFoundException(String manifestId) {
        super("Manifest was not found: " + manifestId);
    }
}
