package io.vaultdatum.server.config;

public enum AccessProfile {
    PRIVATE_NETWORK,
    PUBLIC_TOKEN;

    public static AccessProfile parse(String value) {
        return switch (value) {
            case "private-network" -> PRIVATE_NETWORK;
            case "public-token" -> PUBLIC_TOKEN;
            default -> throw new IllegalArgumentException(
                    "vaultdatum.access-profile must be private-network or public-token");
        };
    }
}
