package io.vaultdatum.server.sync;

import java.nio.file.Path;

public final class SyncPath {

    private final String value;

    private SyncPath(String value) {
        this.value = value;
    }

    public static SyncPath parse(String candidate) {
        if (candidate == null || candidate.isBlank() || candidate.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("A sync path must use non-empty forward-slash segments");
        }

        Path path = Path.of(candidate);
        if (path.isAbsolute() || candidate.startsWith("/") || candidate.endsWith("/")) {
            throw new IllegalArgumentException("A sync path must be Vault-root-relative");
        }

        for (String segment : candidate.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw new IllegalArgumentException("A sync path must not contain traversal segments");
            }
        }

        if (candidate.equals(".obsidian") || candidate.startsWith(".obsidian/")) {
            throw new IllegalArgumentException("The .obsidian directory is not synchronized");
        }

        return new SyncPath(candidate);
    }

    public Path resolveUnder(Path vaultRoot) {
        Path resolved = vaultRoot.resolve(value).normalize();

        if (!resolved.startsWith(vaultRoot)) {
            throw new IllegalArgumentException("A sync path must remain under the Vault root");
        }

        return resolved;
    }

    public String value() {
        return value;
    }
}
