import {
    ServerAuthenticationError,
    type RealtimeTicket,
} from "../transport/access-token";

export interface RevisionAdvancedNotification {
    readonly type: "REVISION_ADVANCED";
    readonly currentRevision: number;
}

export class NotificationChannel {
    private socket: WebSocket | undefined;

    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    private stopped = true;

    public constructor(
        private readonly serverUrl: () => string,
        private readonly shouldUseRealtimeTicket: () => boolean,
        private readonly createRealtimeTicket: (
            serverUrl: string,
        ) => Promise<RealtimeTicket | undefined>,
        private readonly authenticationRequired: () => void,
        private readonly triggerSync: () => void,
    ) {}

    public start(): void {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.connect();
    }

    public restart(): void {
        this.stop();
        this.start();
    }

    public stop(): void {
        this.stopped = true;
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }

        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
    }

    private connect(): void {
        if (this.stopped || this.socket !== undefined) {
            return;
        }

        const url = notificationUrl(this.serverUrl());
        if (url === undefined) {
            return;
        }

        void this.open(url);
    }

    private async open(url: string): Promise<void> {
        let ticket: RealtimeTicket | undefined;
        if (this.shouldUseRealtimeTicket()) {
            try {
                ticket = await this.createRealtimeTicket(this.serverUrl());
            } catch (error: unknown) {
                if (error instanceof ServerAuthenticationError) {
                    this.authenticationRequired();
                } else {
                    this.scheduleReconnect();
                }
                return;
            }
        }
        if (this.stopped || this.socket !== undefined) {
            return;
        }

        let socket: WebSocket;
        try {
            const protocols = notificationProtocols(ticket);
            socket =
                protocols === undefined
                    ? new WebSocket(url)
                    : new WebSocket(url, protocols);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.socket = socket;
        socket.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (revisionAdvancedNotification(event.data) !== undefined) {
                this.triggerSync();
            }
        });
        socket.addEventListener("close", () => {
            if (this.socket !== socket) {
                return;
            }

            this.socket = undefined;
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer !== undefined) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, 5_000);
    }
}

export function notificationProtocols(
    ticket: RealtimeTicket | undefined,
): string[] | undefined {
    if (ticket === undefined) {
        return undefined;
    }
    return ["vaultdatum.v1", `vaultdatum.ticket.${ticket.ticket}`];
}

export function revisionAdvancedNotification(
    data: unknown,
): RevisionAdvancedNotification | undefined {
    if (typeof data !== "string") {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(data) as unknown;
    } catch {
        return undefined;
    }
    if (
        !isRecord(parsed) ||
        parsed.type !== "REVISION_ADVANCED" ||
        typeof parsed.currentRevision !== "number" ||
        !Number.isSafeInteger(parsed.currentRevision) ||
        parsed.currentRevision < 1
    ) {
        return undefined;
    }

    return {
        type: "REVISION_ADVANCED",
        currentRevision: parsed.currentRevision,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function notificationUrl(serverUrl: string): string | undefined {
    if (serverUrl.length === 0) {
        return undefined;
    }

    let url: URL;
    try {
        url = new URL(serverUrl);
    } catch {
        return undefined;
    }
    if (url.protocol === "http:") {
        url.protocol = "ws:";
    } else if (url.protocol === "https:") {
        url.protocol = "wss:";
    } else {
        return undefined;
    }

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/api/v1/notifications`;
    url.search = "";
    url.hash = "";
    return url.toString();
}
