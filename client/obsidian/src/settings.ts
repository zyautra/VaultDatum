export interface VaultDatumSettings {
    serverUrl: string;
    vaultAccessToken: string;
    databaseName: string;
    syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: VaultDatumSettings = {
    serverUrl: "",
    vaultAccessToken: "",
    databaseName: "",
    syncEnabled: true,
};

export function readSettings(value: unknown): VaultDatumSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ...DEFAULT_SETTINGS };
    }

    const stored = value as Record<string, unknown>;
    return {
        serverUrl:
            typeof stored.serverUrl === "string"
                ? stored.serverUrl
                : DEFAULT_SETTINGS.serverUrl,
        vaultAccessToken:
            typeof stored.vaultAccessToken === "string"
                ? stored.vaultAccessToken
                : DEFAULT_SETTINGS.vaultAccessToken,
        databaseName:
            typeof stored.databaseName === "string"
                ? stored.databaseName
                : DEFAULT_SETTINGS.databaseName,
        syncEnabled:
            typeof stored.syncEnabled === "boolean"
                ? stored.syncEnabled
                : DEFAULT_SETTINGS.syncEnabled,
    };
}

export function normalizeServerUrl(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    try {
        const url = new URL(trimmed);
        if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username.length > 0 ||
            url.password.length > 0 ||
            url.search.length > 0 ||
            url.hash.length > 0
        ) {
            return undefined;
        }

        const path = url.pathname.replace(/\/+$/, "");
        return `${url.origin}${path}`;
    } catch {
        return undefined;
    }
}

export function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

export function serverOrigin(value: string): string | undefined {
    const normalized = normalizeServerUrl(value);
    if (normalized === undefined) {
        return undefined;
    }
    return new URL(normalized).origin;
}

export function serverUrlHint(value: string): string {
    if (value.trim().length === 0) {
        return "Enter the complete URL of your VaultDatum server.";
    }
    const normalized = normalizeServerUrl(value);
    if (normalized === undefined) {
        return "Use a complete http:// or https:// URL without credentials or query parameters.";
    }
    if (normalized.startsWith("http://")) {
        return "HTTP is appropriate only on a protected private network, such as a WireGuard VPN.";
    }
    return "The connection will be checked when you test or save this URL.";
}
