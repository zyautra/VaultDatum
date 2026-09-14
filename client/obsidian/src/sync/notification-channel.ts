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

        let socket: WebSocket;
        try {
            socket = new WebSocket(url);
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
