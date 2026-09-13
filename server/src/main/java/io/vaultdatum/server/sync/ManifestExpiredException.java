package io.vaultdatum.server.sync;

public final class ManifestExpiredException extends RuntimeException {

    public ManifestExpiredException(String manifestId) {
        super("Manifest expired: " + manifestId);
    }
}
