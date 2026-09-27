package io.vaultdatum.server.api;

import io.quarkus.runtime.Startup;
import io.quarkus.websockets.next.HttpUpgradeCheck;
import io.smallrye.mutiny.Uni;
import io.vaultdatum.server.config.AccessProfile;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.ws.rs.Priorities;
import jakarta.ws.rs.core.HttpHeaders;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriInfo;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.resteasy.reactive.server.ServerRequestFilter;

@Startup
@ApplicationScoped
public final class AccessAuthenticator implements HttpUpgradeCheck {

    static final String AUTHORIZATION_HEADER = "Authorization";

    static final String BEARER_CHALLENGE = "Bearer realm=\"vaultdatum\"";

    static final String NOTIFICATION_PROTOCOL = "vaultdatum.v1";

    private static final String TICKET_PROTOCOL_PREFIX = "vaultdatum.ticket.";

    private static final Duration TICKET_LIFETIME = Duration.ofSeconds(60);

    private static final int TICKET_BYTES = 16;

    private final AccessProfile profile;

    private final String vaultToken;

    private final SecureRandom random = new SecureRandom();

    private final ConcurrentHashMap<String, Instant> realtimeTickets = new ConcurrentHashMap<>();

    public AccessAuthenticator(
            @ConfigProperty(name = "vaultdatum.access-profile", defaultValue = "private-network") String configuredProfile,
            @ConfigProperty(name = "vaultdatum.auth.token-file") Optional<String> configuredTokenFile) {
        profile = AccessProfile.parse(configuredProfile);
        vaultToken = profile == AccessProfile.PUBLIC_TOKEN
                ? readVaultToken(configuredTokenFile.orElse(""))
                : "";
    }

    @ServerRequestFilter(preMatching = true, priority = Priorities.AUTHENTICATION)
    public Response authenticate(HttpHeaders headers, UriInfo uriInfo) {
        if (profile == AccessProfile.PUBLIC_TOKEN && isSyncApi(uriInfo.getPath()) && !hasValidBearerToken(
                headers.getHeaderString(AUTHORIZATION_HEADER))) {
            return unauthorizedResponse();
        }
        return null;
    }

    public RealtimeTicket issueRealtimeTicket() {
        if (profile != AccessProfile.PUBLIC_TOKEN) {
            throw new IllegalStateException("Realtime tickets require the public-token access profile");
        }

        removeExpiredTickets();
        Instant expiresAt = Instant.now().plus(TICKET_LIFETIME);
        String ticket;
        do {
            ticket = newTicketValue();
        } while (realtimeTickets.putIfAbsent(ticket, expiresAt) != null);
        return new RealtimeTicket(ticket, expiresAt.toString());
    }

    public boolean requiresVaultToken() {
        return profile == AccessProfile.PUBLIC_TOKEN;
    }

    @Override
    public Uni<CheckResult> perform(HttpUpgradeContext context) {
        if (profile != AccessProfile.PUBLIC_TOKEN) {
            return CheckResult.permitUpgrade();
        }

        String ticket = ticketFromProtocols(context.httpRequest().getHeader("Sec-WebSocket-Protocol"));
        if (ticket == null || !consumeRealtimeTicket(ticket)) {
            return CheckResult.rejectUpgrade(Response.Status.UNAUTHORIZED.getStatusCode(),
                    Map.of("WWW-Authenticate", List.of(BEARER_CHALLENGE)));
        }
        return CheckResult.permitUpgrade(Map.of("Sec-WebSocket-Protocol", List.of(NOTIFICATION_PROTOCOL)));
    }

    @Override
    public boolean appliesTo(String endpointId) {
        return NotificationEndpoint.ID.equals(endpointId);
    }

    private boolean isSyncApi(String path) {
        return path.startsWith("api/v1/") || path.startsWith("/api/v1/");
    }

    private boolean hasValidBearerToken(String authorization) {
        if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, "Bearer ".length())) {
            return false;
        }
        String submitted = authorization.substring("Bearer ".length());
        return !submitted.isEmpty() && MessageDigest.isEqual(
                vaultToken.getBytes(StandardCharsets.UTF_8), submitted.getBytes(StandardCharsets.UTF_8));
    }

    private boolean consumeRealtimeTicket(String ticket) {
        Instant expiresAt = realtimeTickets.remove(ticket);
        return expiresAt != null && Instant.now().isBefore(expiresAt);
    }

    private String ticketFromProtocols(String offeredProtocols) {
        if (offeredProtocols == null) {
            return null;
        }

        boolean versionOffered = false;
        String ticket = null;
        for (String candidate : offeredProtocols.split(",")) {
            String protocol = candidate.trim();
            if (NOTIFICATION_PROTOCOL.equals(protocol)) {
                versionOffered = true;
                continue;
            }
            if (protocol.startsWith(TICKET_PROTOCOL_PREFIX)) {
                String parsedTicket = protocol.substring(TICKET_PROTOCOL_PREFIX.length());
                if (!isTicketValue(parsedTicket) || ticket != null) {
                    return null;
                }
                ticket = parsedTicket;
            }
        }
        return versionOffered ? ticket : null;
    }

    private boolean isTicketValue(String value) {
        return value.length() == 22 && value.chars().allMatch(character ->
                (character >= 'A' && character <= 'Z')
                        || (character >= 'a' && character <= 'z')
                        || (character >= '0' && character <= '9')
                        || character == '-'
                        || character == '_');
    }

    private String newTicketValue() {
        byte[] bytes = new byte[TICKET_BYTES];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private void removeExpiredTickets() {
        Instant now = Instant.now();
        realtimeTickets.entrySet().removeIf(entry -> !now.isBefore(entry.getValue()));
    }

    private static String readVaultToken(String configuredTokenFile) {
        if (configuredTokenFile.isBlank()) {
            throw new IllegalStateException("vaultdatum.auth.token-file is required for public-token access");
        }

        String token;
        try {
            token = Files.readString(Path.of(configuredTokenFile), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not read vault access token file", exception);
        }
        token = removeSingleTrailingLineBreak(token);
        if (!token.matches("vd1_[A-Za-z0-9_-]{43}")) {
            throw new IllegalStateException("Vault access token file must contain one vd1_ 256-bit token");
        }
        return token;
    }

    private static String removeSingleTrailingLineBreak(String value) {
        if (value.endsWith("\r\n")) {
            return value.substring(0, value.length() - 2);
        }
        if (value.endsWith("\n")) {
            return value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static Response unauthorizedResponse() {
        return Response.status(Response.Status.UNAUTHORIZED)
                .header("WWW-Authenticate", BEARER_CHALLENGE)
                .type(MediaType.APPLICATION_JSON)
                .entity(new ProtocolErrorResponse(new ErrorResponse("UNAUTHORIZED", "Authentication required")))
                .build();
    }

    public record RealtimeTicket(String ticket, String expiresAt) {
    }
}
