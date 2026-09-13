package io.vaultdatum.server.api;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public record ProtocolErrorResponse(ErrorResponse error) {
}
