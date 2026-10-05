package io.vaultdatum.server.api;

import io.vaultdatum.server.persistence.VaultMetadata;
import io.vaultdatum.server.persistence.VaultMetadataRepository;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

import java.util.List;

@Path("/api/v1/vault")
@Produces(MediaType.APPLICATION_JSON)
public final class VaultResource {

    private final VaultMetadataRepository vaultMetadataRepository;

    public VaultResource(VaultMetadataRepository vaultMetadataRepository) {
        this.vaultMetadataRepository = vaultMetadataRepository;
    }

    @GET
    public VaultInfoResponse vault() {
        VaultMetadata metadata = vaultMetadataRepository.current();
        long oldestRetainedRevision = metadata.currentRevision() == 0 ? 0 : 1;

        return new VaultInfoResponse(
                metadata.vaultId(),
                metadata.currentRevision(),
                oldestRetainedRevision,
                1,
                "SHA-256",
                vaultMetadataRepository.previousVaultIds());
    }

    public record VaultInfoResponse(
            String vaultId,
            long currentRevision,
            long oldestRetainedRevision,
            int protocolVersion,
            String hashAlgorithm,
            List<String> previousVaultIds) {
    }
}
