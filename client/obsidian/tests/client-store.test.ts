import "fake-indexeddb/auto";

import assert from "node:assert/strict";

import { ClientStore, type PendingDelete } from "../src/storage/client-store";

async function resetsOnlySafeSyncTracking(): Promise<void> {
    const store = await ClientStore.open(
        `vaultdatum-client-store-reset-${crypto.randomUUID()}`,
    );
    const clientId = await store.clientId();
    await store.confirmVault("V-1");
    await store.advanceCursor("V-1", 42);
    await store.putReplica({
        path: "notes/a.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 42,
        contentHash: "a".repeat(64),
    });
    await store.completeInitialBootstrap();
    await store.recordSuccessfulSync("2026-09-26T12:00:00.000Z");

    assert.equal((await store.resetEligibility()).eligible, true);
    await store.resetSyncTracking();

    assert.deepEqual(await store.syncState(), { serverCursor: 0 });
    assert.equal(await store.isInitialBootstrapComplete(), false);
    assert.deepEqual(await store.replicas(), []);
    assert.equal(await store.lastSuccessfulSyncAt(), undefined);
    assert.equal(await store.clientId(), clientId);
    store.close();
}

async function blocksResetWhenPendingWorkExists(): Promise<void> {
    const store = await ClientStore.open(
        `vaultdatum-client-store-pending-${crypto.randomUUID()}`,
    );
    const pending: PendingDelete = {
        operationId: "OP-1",
        clientId: await store.clientId(),
        type: "DELETE",
        path: "notes/a.md",
        baseRevision: 1,
        baseContentHash: "b".repeat(64),
        createdAt: "2026-09-26T12:00:00.000Z",
        status: "READY",
    };
    await store.saveDelete(pending);

    const eligibility = await store.resetEligibility();
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.pendingCount, 1);
    await assert.rejects(
        store.resetSyncTracking(),
        /cannot reset sync tracking/,
    );
    assert.equal((await store.pendingOperations()).length, 1);
    store.close();
}

await resetsOnlySafeSyncTracking();
await blocksResetWhenPendingWorkExists();
