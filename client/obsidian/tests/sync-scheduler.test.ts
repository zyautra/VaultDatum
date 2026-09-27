import assert from "node:assert/strict";

import type { SyncSummary } from "../src/sync/create-sync";
import {
    SyncNotConfiguredError,
    SyncPausedError,
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
        isConfigured: () => true,
        onStatus: (status) => statuses.push(status),
    });

    scheduler.schedule();
    await nextTurn();
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
        isConfigured: () => true,
    });

    const initial = scheduler.request();
    const full = scheduler.request("FULL");
    await nextTurn();
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

async function reportsSetupRequiredWithoutRunningAnUnconfiguredServer(): Promise<void> {
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

    await assert.rejects(scheduler.request(), SyncNotConfiguredError);

    assert.equal(statuses.at(-1)?.kind, "SETUP_REQUIRED");
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
        isConfigured: () => true,
        onStatus: (status) => statuses.push(status),
    });

    await assert.rejects(scheduler.request(), /Unexpected transport failure/);

    assert.equal(statuses.at(-1)?.kind, "ERROR");
    scheduler.dispose();
}

async function reportsPausedWithoutRunning(): Promise<void> {
    const statuses: SyncStatus[] = [];
    let runs = 0;
    const scheduler = new SyncScheduler({
        run: async () => {
            runs += 1;
            return successful;
        },
        readActivity: async () => ({
            hasPending: false,
            hasConflicts: false,
        }),
        isConfigured: () => true,
        isEnabled: () => false,
        onStatus: (status) => statuses.push(status),
    });

    await assert.rejects(scheduler.request(), SyncPausedError);

    assert.equal(runs, 0);
    assert.equal(statuses.at(-1)?.kind, "PAUSED");
    scheduler.dispose();
}

async function reportsFirstSyncWhileBootstrapIsIncomplete(): Promise<void> {
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
            initialBootstrapComplete: false,
        }),
        isConfigured: () => true,
        onStatus: (status) => statuses.push(status),
    });

    scheduler.schedule();
    await nextTurn();

    assert.equal(statuses.at(-1)?.kind, "FIRST_SYNC");
    runs[0]?.resolve(successful);
    await nextTurn();
    scheduler.dispose();
}

async function publishesSyncProgressWithoutChangingThePrimaryState(): Promise<void> {
    const statuses: SyncStatus[] = [];
    let reportProgress:
        | ((phase: "CHECKING_SERVER_VAULT" | "CLASSIFYING_LOCAL_FILES") => void)
        | undefined;
    const scheduler = new SyncScheduler({
        run: async (_mode, report) => {
            reportProgress = report;
            return successful;
        },
        readActivity: async () => ({
            hasPending: false,
            hasConflicts: false,
            initialBootstrapComplete: false,
        }),
        isConfigured: () => true,
        onStatus: (status) => statuses.push(status),
    });

    const completed = scheduler.request();
    await nextTurn();

    reportProgress?.("CHECKING_SERVER_VAULT");
    assert.equal(statuses.at(-1)?.kind, "FIRST_SYNC");
    assert.equal(statuses.at(-1)?.phase, "CHECKING_SERVER_VAULT");

    reportProgress?.("CLASSIFYING_LOCAL_FILES");
    assert.equal(statuses.at(-1)?.kind, "FIRST_SYNC");
    assert.equal(statuses.at(-1)?.phase, "CLASSIFYING_LOCAL_FILES");

    await completed;
    scheduler.dispose();
}

async function pausesOnlyAfterAnActiveCycleFinishes(): Promise<void> {
    const runs: DeferredRun[] = [];
    const statuses: SyncStatus[] = [];
    let enabled = true;
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
        isConfigured: () => true,
        isEnabled: () => enabled,
        onStatus: (status) => statuses.push(status),
    });

    scheduler.schedule();
    await nextTurn();
    enabled = false;
    scheduler.refreshAvailability();
    runs[0]?.resolve(successful);
    await nextTurn();

    assert.equal(statuses.at(-1)?.kind, "PAUSED");
    assert.notEqual(statuses.at(-1)?.lastSuccessfulAt, undefined);

    enabled = true;
    scheduler.refreshAvailability();
    assert.equal(statuses.at(-1)?.kind, "IDLE");
    scheduler.dispose();
}

async function stopsAutomaticRetryWhenAnAccessTokenIsRequired(): Promise<void> {
    const statuses: SyncStatus[] = [];
    let runs = 0;
    const scheduler = new SyncScheduler({
        run: async () => {
            runs += 1;
            return { ...successful, authenticationRequired: true };
        },
        readActivity: async () => ({
            hasPending: true,
            hasConflicts: false,
        }),
        isConfigured: () => true,
        retryDelaysMs: [1],
        onStatus: (status) => statuses.push(status),
    });

    await scheduler.request();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(runs, 1);
    assert.equal(statuses.at(-1)?.kind, "AUTHENTICATION_REQUIRED");
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
await reportsSetupRequiredWithoutRunningAnUnconfiguredServer();
await reportsAnUnexpectedRunFailure();
await reportsPausedWithoutRunning();
await reportsFirstSyncWhileBootstrapIsIncomplete();
await publishesSyncProgressWithoutChangingThePrimaryState();
await pausesOnlyAfterAnActiveCycleFinishes();
await stopsAutomaticRetryWhenAnAccessTokenIsRequired();
