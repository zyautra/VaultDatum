import type { SyncSummary } from "./create-sync";

export type SyncMode = "INCREMENTAL" | "FULL";

export type SyncStatusKind =
    | "IDLE"
    | "SYNCING"
    | "UP_TO_DATE"
    | "PENDING"
    | "OFFLINE"
    | "CONFLICT"
    | "ERROR";

export interface SyncStatus {
    readonly kind: SyncStatusKind;
    readonly lastSuccessfulAt?: string;
    readonly summary?: SyncSummary;
}

export interface SyncActivity {
    readonly hasPending: boolean;
    readonly hasConflicts: boolean;
}

export interface SyncSchedulerOptions {
    readonly run: (mode: SyncMode) => Promise<SyncSummary>;
    readonly readActivity: () => Promise<SyncActivity>;
    readonly isConfigured: () => boolean;
    readonly onStatus?: (status: SyncStatus) => void;
    readonly retryDelaysMs?: readonly number[];
}

interface Waiter {
    readonly generation: number;
    readonly resolve: (summary: SyncSummary) => void;
    readonly reject: (reason: unknown) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 60_000] as const;

export class SyncScheduler {
    private disposed = false;

    private fullScheduled = false;

    private generation = 0;

    private lastSuccessfulAt: string | undefined;

    private retryAttempt = 0;

    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    private running = false;

    private scheduled = false;

    private readonly retryDelaysMs: readonly number[];

    private readonly waiters: Waiter[] = [];

    public constructor(private readonly options: SyncSchedulerOptions) {
        this.retryDelaysMs =
            options.retryDelaysMs?.filter(
                (delay) => Number.isSafeInteger(delay) && delay > 0,
            ) ?? DEFAULT_RETRY_DELAYS_MS;
        this.publish({ kind: "IDLE" });
    }

    public schedule(mode: SyncMode = "INCREMENTAL"): void {
        void this.request(mode).catch(() => undefined);
    }

    public request(mode: SyncMode = "INCREMENTAL"): Promise<SyncSummary> {
        if (this.disposed) {
            return Promise.reject(
                new Error("VaultDatum sync scheduler is stopped"),
            );
        }

        this.cancelRetry();
        this.scheduled = true;
        this.fullScheduled ||= mode === "FULL";
        const generation = ++this.generation;
        const completion = new Promise<SyncSummary>((resolve, reject) => {
            this.waiters.push({ generation, resolve, reject });
        });
        this.start();
        return completion;
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.scheduled = false;
        this.fullScheduled = false;
        this.cancelRetry();
        this.rejectThrough(
            Number.POSITIVE_INFINITY,
            new Error("VaultDatum sync scheduler is stopped"),
        );
    }

    private start(): void {
        if (this.running || this.disposed) {
            return;
        }

        this.running = true;
        void this.drain();
    }

    private async drain(): Promise<void> {
        try {
            while (this.scheduled && !this.disposed) {
                this.scheduled = false;
                const generation = this.generation;
                const mode: SyncMode = this.fullScheduled
                    ? "FULL"
                    : "INCREMENTAL";
                this.fullScheduled = false;
                this.publish({
                    kind: "SYNCING",
                    lastSuccessfulAt: this.lastSuccessfulAt,
                });

                try {
                    const summary = await this.options.run(mode);
                    if (this.disposed) {
                        return;
                    }
                    await this.publishSummary(summary);
                    this.resolveThrough(generation, summary);
                } catch (error: unknown) {
                    this.publish({
                        kind: "ERROR",
                        lastSuccessfulAt: this.lastSuccessfulAt,
                    });
                    this.scheduleRetry();
                    this.rejectThrough(generation, error);
                }
            }
        } finally {
            this.running = false;
            if (this.scheduled && !this.disposed) {
                this.start();
            }
        }
    }

    private async publishSummary(summary: SyncSummary): Promise<void> {
        if (summary.vaultMismatch) {
            this.publish({
                kind: "ERROR",
                lastSuccessfulAt: this.lastSuccessfulAt,
                summary,
            });
            return;
        }
        if (summary.offline) {
            this.publish({
                kind: "OFFLINE",
                lastSuccessfulAt: this.lastSuccessfulAt,
                summary,
            });
            this.scheduleRetry();
            return;
        }

        this.retryAttempt = 0;
        this.lastSuccessfulAt = new Date().toISOString();

        try {
            const activity = await this.options.readActivity();
            this.publish({
                kind: statusKind(summary, activity),
                lastSuccessfulAt: this.lastSuccessfulAt,
                summary,
            });
        } catch (error: unknown) {
            console.warn(
                "VaultDatum could not read synchronization status",
                error,
            );
            this.publish({
                kind: "ERROR",
                lastSuccessfulAt: this.lastSuccessfulAt,
                summary,
            });
        }
    }

    private scheduleRetry(): void {
        if (
            this.disposed ||
            !this.options.isConfigured() ||
            this.retryTimer !== undefined ||
            this.retryDelaysMs.length === 0
        ) {
            return;
        }

        const index = Math.min(
            this.retryAttempt,
            this.retryDelaysMs.length - 1,
        );
        const delay = this.retryDelaysMs[index];
        if (delay === undefined) {
            return;
        }
        this.retryAttempt += 1;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.schedule();
        }, delay);
    }

    private cancelRetry(): void {
        if (this.retryTimer === undefined) {
            return;
        }

        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
    }

    private publish(status: SyncStatus): void {
        try {
            this.options.onStatus?.(status);
        } catch (error: unknown) {
            console.warn(
                "VaultDatum synchronization status observer failed",
                error,
            );
        }
    }

    private resolveThrough(generation: number, summary: SyncSummary): void {
        const retained: Waiter[] = [];
        for (const waiter of this.waiters) {
            if (waiter.generation <= generation) {
                waiter.resolve(summary);
            } else {
                retained.push(waiter);
            }
        }
        this.waiters.splice(0, this.waiters.length, ...retained);
    }

    private rejectThrough(generation: number, reason: unknown): void {
        const retained: Waiter[] = [];
        for (const waiter of this.waiters) {
            if (waiter.generation <= generation) {
                waiter.reject(reason);
            } else {
                retained.push(waiter);
            }
        }
        this.waiters.splice(0, this.waiters.length, ...retained);
    }
}

function statusKind(
    summary: SyncSummary,
    activity: SyncActivity,
): SyncStatusKind {
    if (summary.conflicted > 0 || activity.hasConflicts) {
        return "CONFLICT";
    }
    if (summary.oversized > 0 || activity.hasPending) {
        return "PENDING";
    }
    return "UP_TO_DATE";
}
