package io.vaultdatum.server.config;

import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;

@ApplicationScoped
public final class ContentLimits {

    private final long maximumContentBytes;

    public ContentLimits(@ConfigProperty(name = "vaultdatum.max-content-bytes") long maximumContentBytes) {
        if (maximumContentBytes < 1) {
            throw new IllegalArgumentException("vaultdatum.max-content-bytes must be positive");
        }

        this.maximumContentBytes = maximumContentBytes;
    }

    public boolean accepts(long size) {
        return size >= 0 && size <= maximumContentBytes;
    }

    public long maximumContentBytes() {
        return maximumContentBytes;
    }
}
