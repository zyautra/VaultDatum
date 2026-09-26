import assert from "node:assert/strict";

import type { SyncSummary } from "../src/sync/create-sync";
import {
    SyncScheduler,
    type SyncMode,
    type SyncStatus,
} from "../src/sync/sync-scheduler";

const successful: SyncSummary = {
    committed: 0,
    conflicted: 0,
    oversized: 0,
    offline: false,
    vaultMismatch: false,
};

async function schedulesAFollowUpForATriggerDuringSync(): Promise<void> {
    const runs: DeferredRun[] = [];
    const statuses: SyncStatus[] = [];
    const scheduler = new SyncScheduler({
        run: (mode) => {
            const deferred = new DeferredRun(mode);
            runs.push(deferred);
            return deferred.promise;
        },
        readActivity: async () => ({
            hasPending: false,
            hasConflicts: false,
        }),
        isConfigured: () => false,
        onStatus: (status) => statuses.push(status),
    });

    scheduler.schedule();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.mode, "INCREMENTAL");

    scheduler.schedule();
    scheduler.schedule();
    assert.equal(runs.length, 1);

    runs[0]?.resolve(successful);
    await nextTurn();

    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.mode, "INCREMENTAL");
    runs[1]?.resolve(successful);
    await nextTurn();

    assert.deepEqual(
        statuses.map((status) => status.kind),
        ["IDLE", "SYNCING", "UP_TO_DATE", "SYNCING", "UP_TO_DATE"],
    );
    assert.notEqual(statuses.at(-1)?.lastSuccessfulAt, undefined);
    scheduler.dispose();
}

async function runsAQueuedFullReconciliationAfterTheCurrentSync(): Promise<void> {
    const runs: DeferredRun[] = [];
    const scheduler = new SyncScheduler({
        run: (mode) => {
            const deferred = new DeferredRun(mode);
            runs.push(deferred);
            return deferred.promise;
        },
        readActivity: async () => ({
            hasPending: false,
            hasConflicts: false,
        }),
        isConfigured: () => false,
    });

    const initial = scheduler.request();
    const full = scheduler.request("FULL");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.mode, "INCREMENTAL");

    runs[0]?.resolve(successful);
    await initial;
    await nextTurn();

    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.mode, "FULL");
    runs[1]?.resolve(successful);
    await full;
    scheduler.dispose();
}

async function reportsOfflineWithoutRetryingAnUnconfiguredServer(): Promise<void> {
    const statuses: SyncStatus[] = [];
    const scheduler = new SyncScheduler({
        run: async () => ({ ...successful, offline: true }),
        readActivity: async () => ({
            hasPending: true,
            hasConflicts: false,
        }),
        isConfigured: () => false,
        onStatus: (status) => statuses.push(status),
    });

    await scheduler.request();

    assert.equal(statuses.at(-1)?.kind, "OFFLINE");
    scheduler.dispose();
}

async function reportsAnUnexpectedRunFailure(): Promise<void> {
    const statuses: SyncStatus[] = [];
    const scheduler = new SyncScheduler({
        run: async () => {
            throw new Error("Unexpected transport failure");
        },
        readActivity: async () => ({
            hasPending: false,
            hasConflicts: false,
        }),
        isConfigured: () => false,
        onStatus: (status) => statuses.push(status),
    });

    await assert.rejects(scheduler.request(), /Unexpected transport failure/);

    assert.equal(statuses.at(-1)?.kind, "ERROR");
    scheduler.dispose();
}

class DeferredRun {
    public readonly promise: Promise<SyncSummary>;

    private complete: ((summary: SyncSummary) => void) | undefined;

    public constructor(public readonly mode: SyncMode) {
        this.promise = new Promise<SyncSummary>((resolve) => {
            this.complete = resolve;
        });
    }

    public resolve(summary: SyncSummary): void {
        const complete = this.complete;
        if (complete === undefined) {
            throw new Error("Deferred sync run was not initialized");
        }
        complete(summary);
    }
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

await schedulesAFollowUpForATriggerDuringSync();
await runsAQueuedFullReconciliationAfterTheCurrentSync();
await reportsOfflineWithoutRetryingAnUnconfiguredServer();
await reportsAnUnexpectedRunFailure();
