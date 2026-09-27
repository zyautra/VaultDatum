export class ServerAuthenticationError extends Error {
    public constructor() {
        super("VaultDatum server requires a valid Vault access token");
    }
}

export interface RealtimeTicket {
    readonly ticket: string;
    readonly expiresAt: string;
}
