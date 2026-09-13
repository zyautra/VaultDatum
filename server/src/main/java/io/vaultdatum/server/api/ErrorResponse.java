package io.vaultdatum.server.api;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public record ErrorResponse(String code, String message) {
}
