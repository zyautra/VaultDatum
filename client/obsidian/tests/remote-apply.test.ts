import "fake-indexeddb/auto";

import assert from "node:assert/strict";

import { contentHash } from "../src/core/content-hash";
import { MAX_SYNC_CONTENT_BYTES } from "../src/core/content-limits";
import {
    ClientStore,
    type KeepBothResolution,
    type ManualMergeResolution,
    type PendingCreate,
    type PendingDelete,
    type PendingDirectoryCreate,
    type PendingDirectoryDelete,
    type PendingDirectoryMove,
    type PendingDirectoryRename,
    type PendingMove,
    type PendingModify,
    type PendingRename,
} from "../src/storage/client-store";
import { CreateSync } from "../src/sync/create-sync";
import { type LocalVault, RemoteApply } from "../src/sync/remote-apply";
import type {
    ContentTransport,
    ReadResult,
    RemoteChange,
    RemoteChangePage,
    RemoteManifest,
    RemoteManifestCreated,
    RemoteManifestEntry,
    RemoteVaultInfo,
    SubmitOperationResult,
    SyncTransport,
} from "../src/transport/server-client";

async function appliesARemoteCreateToAnEmptyVault(): Promise<void> {
    const content = bytes("Remote note");
    const contentHashValue = await contentHash(content);
    const store = await ClientStore.open(
        `test-remote-create-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const apply = new RemoteApply(store, new DownloadTransport(content), vault);

    const result = await apply.integrateChange(
        "https://vaultdatum.test",
        createChange("notes/remote.md", contentHashValue, content.byteLength),
    );

    assert.equal(result.conflicted, 0);
    assert.equal(await vault.hash("notes/remote.md"), contentHashValue);
    assert.deepEqual(await store.replica("notes/remote.md"), {
        path: "notes/remote.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 1,
        contentHash: contentHashValue,
        size: content.byteLength,
    });
    assert.deepEqual(await store.applyIntents(), []);
    store.close();
}

async function appliesABinaryAttachmentWithoutTextConversion(): Promise<void> {
    const path = "attachments/diagram.png";
    const content = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10]).buffer;
    const contentHashValue = await contentHash(content);
    const store = await ClientStore.open(
        `test-binary-attachment-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const apply = new RemoteApply(store, new DownloadTransport(content), vault);

    const result = await apply.integrateChange(
        "https://vaultdatum.test",
        createChange(path, contentHashValue, content.byteLength),
    );

    assert.equal(result.conflicted, 0);
    assert.deepEqual(
        new Uint8Array((await vault.readFile(path)) ?? new ArrayBuffer(0)),
        new Uint8Array(content),
    );
    store.close();
}

async function appliesAnEmptyRemoteDirectory(): Promise<void> {
    const path = "notes/empty";
    const store = await ClientStore.open(
        `test-remote-directory-create-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const apply = new RemoteApply(
        store,
        new DownloadTransport(bytes("")),
        vault,
    );

    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 1,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [{ path, entryType: "DIRECTORY", state: "PRESENT" }],
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await vault.directoryExists(path), true);
    assert.deepEqual(await store.replica(path), {
        path,
        entryType: "DIRECTORY",
        state: "PRESENT",
        revision: 1,
    });
    assert.deepEqual(await store.applyIntents(), []);
    store.close();
}

async function appliesAnEmptyRemoteDirectoryDelete(): Promise<void> {
    const path = "notes/empty";
    const store = await ClientStore.open(
        `test-remote-directory-delete-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.createDirectory(path);
    await store.putReplica({
        path,
        entryType: "DIRECTORY",
        state: "PRESENT",
        revision: 1,
    });
    const apply = new RemoteApply(
        store,
        new DownloadTransport(bytes("")),
        vault,
    );

    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 2,
        type: "DELETE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [{ path, entryType: "DIRECTORY", state: "DELETED" }],
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await vault.directoryExists(path), false);
    assert.deepEqual(await store.replica(path), {
        path,
        entryType: "DIRECTORY",
        state: "DELETED",
        revision: 2,
    });
    store.close();
}

async function queuesAnEmptyLocalDirectory(): Promise<void> {
    const path = "notes/empty";
    const store = await ClientStore.open(
        `test-local-directory-create-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.createDirectory(path);
    const sync = new CreateSync(store, new NoopTransport(), vault, () => "");

    const pending = await sync.captureDirectoryCreate(path);

    assert.equal(pending?.type, "DIRECTORY_CREATE");
    assert.equal((await store.pendingOperations()).length, 1);
    store.close();
}

async function observesAnOwnDirectoryMove(): Promise<void> {
    const sourcePath = "notes/empty";
    const destinationPath = "archive/empty";
    const store = await ClientStore.open(
        `test-own-directory-move-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.createDirectory(destinationPath);
    const clientId = await store.clientId();
    const pending = {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId,
        type: "DIRECTORY_MOVE" as const,
        path: sourcePath,
        destinationPath,
        baseRevision: 1,
        createdAt: new Date().toISOString(),
        status: "COMMITTED" as const,
    };
    await store.saveDirectoryOperation(pending);
    await store.putReplica({
        path: sourcePath,
        entryType: "DIRECTORY",
        state: "PRESENT",
        revision: 1,
    });

    const apply = new RemoteApply(
        store,
        new DownloadTransport(bytes("")),
        vault,
    );
    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 2,
        type: "MOVE",
        operationId: pending.operationId,
        actor: { type: "CLIENT", clientId },
        effects: [
            { path: sourcePath, entryType: "DIRECTORY", state: "DELETED" },
            {
                path: destinationPath,
                entryType: "DIRECTORY",
                state: "PRESENT",
            },
        ],
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await store.operation(pending.operationId), undefined);
    assert.deepEqual(await store.replica(destinationPath), {
        path: destinationPath,
        entryType: "DIRECTORY",
        state: "PRESENT",
        revision: 2,
    });
    store.close();
}

async function preservesANonEmptyLocalDirectoryDuringARemoteMove(): Promise<void> {
    const sourcePath = "notes/empty";
    const destinationPath = "archive/empty";
    const store = await ClientStore.open(
        `test-remote-directory-move-conflict-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.createDirectory(sourcePath);
    await vault.writeFile(`${sourcePath}/local.md`, bytes("local-only"));
    await store.putReplica({
        path: sourcePath,
        entryType: "DIRECTORY",
        state: "PRESENT",
        revision: 1,
    });
    const apply = new RemoteApply(
        store,
        new DownloadTransport(bytes("")),
        vault,
    );

    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 2,
        type: "MOVE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            { path: sourcePath, entryType: "DIRECTORY", state: "DELETED" },
            {
                path: destinationPath,
                entryType: "DIRECTORY",
                state: "PRESENT",
            },
        ],
    });

    assert.equal(result.conflicted, 2);
    assert.equal(await vault.directoryExists(sourcePath), true);
    assert.equal(await vault.directoryExists(destinationPath), false);
    assert.equal((await store.conflicts()).length, 2);
    store.close();
}

async function refusesToQueueContentAboveTheAttachmentLimit(): Promise<void> {
    const store = await ClientStore.open(
        `test-oversized-attachment-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const sync = new CreateSync(store, new NoopTransport(), vault, () => "");

    const pending = await sync.captureCreate(
        "attachments/too-large.bin",
        new ArrayBuffer(MAX_SYNC_CONTENT_BYTES + 1),
    );

    assert.equal(pending, undefined);
    assert.deepEqual(await store.pendingOperations(), []);
    store.close();
}

async function skipsOversizedAttachmentsDuringReconciliation(): Promise<void> {
    const store = await ClientStore.open(
        `test-oversized-reconciliation-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(
        "attachments/too-large.bin",
        new ArrayBuffer(MAX_SYNC_CONTENT_BYTES + 1),
    );
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(0, 0, [], new Map()),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.deepEqual(summary, {
        committed: 0,
        conflicted: 0,
        oversized: 1,
        offline: false,
        vaultMismatch: false,
        initialBootstrap: true,
    });
    assert.deepEqual(await store.pendingOperations(), []);
    store.close();
}

async function refusesAnOversizedRemoteAttachmentBeforeDownloading(): Promise<void> {
    const path = "attachments/server-too-large.pdf";
    const smallContent = bytes("This content must not be downloaded");
    const store = await ClientStore.open(
        `test-oversized-remote-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const apply = new RemoteApply(store, new NoopTransport(), vault);

    const result = await apply.integrateChange(
        "https://vaultdatum.test",
        createChange(
            path,
            await contentHash(smallContent),
            MAX_SYNC_CONTENT_BYTES + 1,
        ),
    );

    assert.equal(result.conflicted, 1);
    assert.equal(await vault.readFile(path), undefined);
    assert.equal(
        (await store.conflict(path))?.code,
        "REMOTE_CONTENT_TOO_LARGE",
    );
    store.close();
}

async function initializesFromAManifestAndCatchesUpLaterChanges(): Promise<void> {
    const path = "notes/manifest-initial.md";
    const snapshotContent = bytes("Content in the manifest snapshot");
    const laterContent = bytes("Content changed after the manifest snapshot");
    const snapshotHash = await contentHash(snapshotContent);
    const laterHash = await contentHash(laterContent);
    const transport = new ManifestTransport(
        path,
        snapshotContent,
        {
            revision: 2,
            type: "MODIFY",
            operationId: `OP-${crypto.randomUUID()}`,
            actor: { type: "CLIENT", clientId: "C-remote-client" },
            effects: [
                {
                    path,
                    entryType: "FILE",
                    state: "PRESENT",
                    contentHash: laterHash,
                    size: laterContent.byteLength,
                },
            ],
        },
        laterContent,
    );
    const store = await ClientStore.open(
        `test-manifest-initial-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const sync = new CreateSync(
        store,
        transport,
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, false);
    assert.equal(summary.conflicted, 0);
    assert.equal(transport.manifestCreates, 1);
    assert.equal(transport.manifestReads, 1);
    assert.equal(await vault.hash(path), laterHash);
    assert.equal((await store.replica(path))?.contentHash, laterHash);
    assert.equal((await store.syncState()).serverCursor, 2);
    assert.notEqual(snapshotHash, laterHash);
    store.close();
}

async function preservesExistingLocalContentDuringInitialManifestSync(): Promise<void> {
    const path = "notes/manifest-conflict.md";
    const snapshotContent = bytes("Authoritative manifest content");
    const localContent = bytes("Existing local content");
    const snapshotHash = await contentHash(snapshotContent);
    const transport = new ManifestTransport(path, snapshotContent);
    const store = await ClientStore.open(
        `test-manifest-conflict-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    const sync = new CreateSync(
        store,
        transport,
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, false);
    assert.equal(summary.conflicted, 1);
    assert.equal(await vault.hash(path), await contentHash(localContent));
    assert.equal(await store.hasConflict(path), true);
    assert.equal((await store.replica(path))?.contentHash, snapshotHash);
    assert.equal((await store.syncState()).serverCursor, 1);
    store.close();
}

async function recoversAMissedLocalModificationDuringIntegrityScan(): Promise<void> {
    const path = "notes/missed-local-modify.md";
    const base = bytes("Replicated base content");
    const local = bytes("Local content after a missed event");
    const baseHash = await contentHash(base);
    const store = await ClientStore.open(
        `test-local-integrity-${crypto.randomUUID()}`,
    );
    await store.advanceCursor("V-reconciliation", 1);
    await store.putReplica({
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision: 1,
        contentHash: baseHash,
        size: base.byteLength,
    });
    const vault = new MemoryVault();
    await vault.writeFile(path, local);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(
            1,
            1,
            [presentManifestEntry(path, 1, baseHash, base.byteLength)],
            new Map([[path, base]]),
        ),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, true);
    assert.equal(summary.conflicted, 0);
    const [pending] = await store.pendingOperations();
    assert.equal(pending?.type, "MODIFY");
    assert.equal(pending?.path, path);
    if (pending?.type === "MODIFY") {
        assert.equal(pending.baseRevision, 1);
        assert.equal(pending.baseContentHash, baseHash);
        assert.equal(pending.contentHash, await contentHash(local));
    }
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.isInitialBootstrapComplete(), true);
    store.close();
}

async function preservesAMissedLocalDeletionDuringInitialBootstrap(): Promise<void> {
    const path = "notes/missed-local-delete.md";
    const base = bytes("Replicated base content");
    const baseHash = await contentHash(base);
    const store = await ClientStore.open(
        `test-local-delete-bootstrap-${crypto.randomUUID()}`,
    );
    await store.advanceCursor("V-reconciliation", 1);
    await store.putReplica({
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision: 1,
        contentHash: baseHash,
        size: base.byteLength,
    });
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(
            1,
            1,
            [presentManifestEntry(path, 1, baseHash, base.byteLength)],
            new Map([[path, base]]),
        ),
        new MemoryVault(),
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, true);
    assert.equal(summary.conflicted, 0);
    const [pending] = await store.pendingOperations();
    assert.equal(pending?.type, "DELETE");
    assert.equal(pending?.path, path);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.isInitialBootstrapComplete(), true);
    store.close();
}

async function queuesInitialUntrackedFilesAfterServerManifest(): Promise<void> {
    const path = "notes/preexisting-local.md";
    const initial = bytes("Pre-existing local content");
    const store = await ClientStore.open(
        `test-local-baseline-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, initial);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(0, 0, [], new Map()),
        vault,
        () => "https://vaultdatum.test",
    );

    const initialSummary = await sync.sync();

    assert.equal(initialSummary.offline, true);
    const [pending] = await store.pendingOperations();
    assert.equal(pending?.type, "CREATE");
    assert.equal(pending?.path, path);
    assert.equal(await store.isInitialBootstrapComplete(), true);
    store.close();
}

async function doesNotCompleteBootstrapWhileTheServerIsUnavailable(): Promise<void> {
    const path = "notes/wait-for-server.md";
    const local = bytes("Must not upload before a server manifest");
    const store = await ClientStore.open(
        `test-bootstrap-server-unavailable-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, local);
    const sync = new CreateSync(
        store,
        new NoopTransport(),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, true);
    assert.equal(await store.isInitialBootstrapComplete(), false);
    assert.deepEqual(await store.pendingOperations(), []);
    store.close();
}

async function quarantinesAFileThatReappearsAfterServerDeletion(): Promise<void> {
    const path = "notes/reappeared-after-delete.md";
    const local = bytes("A stale or locally restored file");
    const store = await ClientStore.open(
        `test-reappeared-tombstone-${crypto.randomUUID()}`,
    );
    await store.advanceCursor("V-reconciliation", 1);
    await store.putReplica({
        path,
        entryType: "FILE",
        state: "DELETED",
        revision: 1,
    });
    const vault = new MemoryVault();
    await vault.writeFile(path, local);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(
            1,
            1,
            [deletedManifestEntry(path, 1)],
            new Map(),
        ),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, false);
    assert.equal(summary.conflicted, 1);
    assert.equal(await vault.hash(path), await contentHash(local));
    assert.equal((await store.conflict(path))?.code, "LOCAL_STATE_DIVERGED");
    assert.deepEqual(await store.pendingOperations(), []);
    store.close();
}

async function repairsAMissingReplicaEntryFromTheServerManifest(): Promise<void> {
    const path = "notes/missing-replica.md";
    const serverContent = bytes("Authoritative content already on disk");
    const serverHash = await contentHash(serverContent);
    const store = await ClientStore.open(
        `test-manifest-repair-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, serverContent);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(
            7,
            7,
            [
                presentManifestEntry(
                    path,
                    7,
                    serverHash,
                    serverContent.byteLength,
                ),
            ],
            new Map([[path, serverContent]]),
        ),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.fullReconcile();

    assert.equal(summary.offline, false);
    assert.equal(summary.conflicted, 0);
    assert.deepEqual(await store.replica(path), {
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision: 7,
        contentHash: serverHash,
        size: serverContent.byteLength,
    });
    assert.equal((await store.syncState()).serverCursor, 7);
    store.close();
}

async function preservesLocalContentWhenManifestDeletionOverlapsMissedEdit(): Promise<void> {
    const path = "notes/delete-versus-missed-edit.md";
    const base = bytes("Server base content");
    const local = bytes("Local content after a missed modify event");
    const baseHash = await contentHash(base);
    const store = await ClientStore.open(
        `test-manifest-delete-conflict-${crypto.randomUUID()}`,
    );
    await store.advanceCursor("V-reconciliation", 1);
    await store.putReplica({
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision: 1,
        contentHash: baseHash,
        size: base.byteLength,
    });
    const vault = new MemoryVault();
    await vault.writeFile(path, local);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(
            2,
            2,
            [deletedManifestEntry(path, 2)],
            new Map(),
        ),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.fullReconcile();

    assert.equal(summary.offline, false);
    assert.equal(summary.conflicted, 1);
    assert.equal(await vault.hash(path), await contentHash(local));
    assert.equal(
        (await store.conflict(path))?.code,
        "SERVER_MANIFEST_OVERLAPS_PENDING",
    );
    assert.deepEqual(await store.replica(path), {
        path,
        entryType: "FILE",
        state: "DELETED",
        revision: 2,
    });
    store.close();
}

async function fallsBackToAManifestWhenHistoryIsUnavailable(): Promise<void> {
    const path = "notes/history-gap.md";
    const base = bytes("Content before journal retention");
    const serverContent = bytes("Current content after journal retention");
    const baseHash = await contentHash(base);
    const serverHash = await contentHash(serverContent);
    const store = await ClientStore.open(
        `test-history-manifest-fallback-${crypto.randomUUID()}`,
    );
    await store.advanceCursor("V-reconciliation", 1);
    await store.putReplica({
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision: 1,
        contentHash: baseHash,
        size: base.byteLength,
    });
    const vault = new MemoryVault();
    await vault.writeFile(path, base);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(
            2,
            2,
            [
                presentManifestEntry(
                    path,
                    2,
                    serverHash,
                    serverContent.byteLength,
                ),
            ],
            new Map([[path, serverContent]]),
            true,
        ),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.equal(summary.offline, false);
    assert.equal(summary.conflicted, 0);
    assert.equal(await vault.hash(path), serverHash);
    assert.equal((await store.replica(path))?.revision, 2);
    assert.equal((await store.syncState()).serverCursor, 2);
    store.close();
}

async function discardsAnApplyInterruptedBeforeContentIsStaged(): Promise<void> {
    const path = "notes/prepared-apply.md";
    const remote = bytes("Remote content waiting to download");
    const remoteHash = await contentHash(remote);
    const store = await ClientStore.open(
        `test-prepared-apply-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const apply = new RemoteApply(store, new NoopTransport(), vault);

    await assert.rejects(
        apply.integrateChange(
            "https://vaultdatum.test",
            createChange(path, remoteHash, remote.byteLength),
        ),
        /Could not download remote content/,
    );
    assert.deepEqual(await store.applyIntents(), [
        {
            applyId: `1:${path}`,
            path,
            before: undefined,
            after: {
                path,
                entryType: "FILE",
                state: "PRESENT",
                revision: 1,
                contentHash: remoteHash,
                size: remote.byteLength,
            },
            phase: "PREPARED",
            artifactId: `apply-1:${path}`,
        },
    ]);

    await apply.recoverInterruptedApplies();

    assert.deepEqual(await store.applyIntents(), []);
    assert.equal(await vault.readFile(path), undefined);
    assert.equal(await store.replica(path), undefined);
    store.close();
}

async function resumesAStagedApplyAfterRestartBeforeLocalWrite(): Promise<void> {
    const path = "notes/staged-apply.md";
    const remote = bytes("Durable remote apply content");
    const remoteHash = await contentHash(remote);
    const databaseName = `test-staged-apply-${crypto.randomUUID()}`;
    const store = await ClientStore.open(databaseName);
    const vault = new FaultingMemoryVault();
    vault.failBeforeNextWrite();
    const apply = new RemoteApply(store, new DownloadTransport(remote), vault);

    await assert.rejects(
        apply.integrateChange(
            "https://vaultdatum.test",
            createChange(path, remoteHash, remote.byteLength),
        ),
        /Simulated write failure before local mutation/,
    );
    const [staged] = await store.applyIntents();
    assert.equal(staged?.phase, "CONTENT_READY");
    if (staged === undefined) {
        throw new Error("Expected staged apply metadata");
    }
    assert.equal((await store.applyContent(staged)) instanceof Blob, true);
    store.close();

    const restartedStore = await ClientStore.open(databaseName);
    const restartedApply = new RemoteApply(
        restartedStore,
        new NoopTransport(),
        vault,
    );
    await restartedApply.recoverInterruptedApplies();

    assert.equal(await vault.hash(path), remoteHash);
    assert.equal((await restartedStore.replica(path))?.revision, 1);
    assert.deepEqual(await restartedStore.applyIntents(), []);
    restartedStore.close();
}

async function finalizesAnApplyAfterLocalWriteBeforeMetadataFinalization(): Promise<void> {
    const path = "notes/applied-before-finalize.md";
    const remote = bytes("Remote content written before metadata finalization");
    const remoteHash = await contentHash(remote);
    const databaseName = `test-applied-before-finalize-${crypto.randomUUID()}`;
    const store = await ClientStore.open(databaseName);
    const vault = new FaultingMemoryVault();
    vault.failAfterNextWrite();
    const apply = new RemoteApply(store, new DownloadTransport(remote), vault);

    await assert.rejects(
        apply.integrateChange(
            "https://vaultdatum.test",
            createChange(path, remoteHash, remote.byteLength),
        ),
        /Simulated write failure after local mutation/,
    );
    assert.equal(await vault.hash(path), remoteHash);
    assert.equal((await store.applyIntents())[0]?.phase, "CONTENT_READY");
    assert.equal(await store.replica(path), undefined);
    store.close();

    const restartedStore = await ClientStore.open(databaseName);
    const restartedApply = new RemoteApply(
        restartedStore,
        new NoopTransport(),
        vault,
    );
    await restartedApply.recoverInterruptedApplies();

    assert.equal(await vault.hash(path), remoteHash);
    assert.equal((await restartedStore.replica(path))?.revision, 1);
    assert.deepEqual(await restartedStore.applyIntents(), []);
    restartedStore.close();
}

async function preservesUnexpectedLocalContentDuringApplyRecovery(): Promise<void> {
    const path = "notes/unexpected-apply.md";
    const remote = bytes("Remote content that must not overwrite a later edit");
    const local = bytes("Local content written after interruption");
    const remoteHash = await contentHash(remote);
    const databaseName = `test-unexpected-apply-${crypto.randomUUID()}`;
    const store = await ClientStore.open(databaseName);
    const vault = new FaultingMemoryVault();
    vault.failBeforeNextWrite();
    const apply = new RemoteApply(store, new DownloadTransport(remote), vault);

    await assert.rejects(
        apply.integrateChange(
            "https://vaultdatum.test",
            createChange(path, remoteHash, remote.byteLength),
        ),
        /Simulated write failure before local mutation/,
    );
    await vault.writeFile(path, local);
    store.close();

    const restartedStore = await ClientStore.open(databaseName);
    const restartedApply = new RemoteApply(
        restartedStore,
        new NoopTransport(),
        vault,
    );
    await restartedApply.recoverInterruptedApplies();

    assert.equal(await vault.hash(path), await contentHash(local));
    assert.equal(
        (await restartedStore.conflict(path))?.code,
        "REMOTE_APPLY_RECOVERY_REQUIRED",
    );
    assert.equal((await restartedStore.replica(path))?.contentHash, remoteHash);
    assert.deepEqual(await restartedStore.applyIntents(), []);
    restartedStore.close();
}

async function preservesAnExistingLocalFileAsAConflict(): Promise<void> {
    const local = bytes("Local note");
    const remote = bytes("Remote note");
    const remoteHash = await contentHash(remote);
    const store = await ClientStore.open(
        `test-remote-conflict-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile("notes/conflict.md", local);
    const apply = new RemoteApply(store, new DownloadTransport(remote), vault);

    const result = await apply.integrateChange(
        "https://vaultdatum.test",
        createChange("notes/conflict.md", remoteHash, remote.byteLength),
    );

    assert.equal(result.conflicted, 1);
    assert.equal(
        await vault.hash("notes/conflict.md"),
        await contentHash(local),
    );
    assert.equal(await store.hasConflict("notes/conflict.md"), true);
    assert.equal(
        (await store.replica("notes/conflict.md"))?.contentHash,
        remoteHash,
    );
    store.close();
}

async function integratesAnOwnChangeAfterTheOperationResponseWasLost(): Promise<void> {
    const content = bytes("Own pending note");
    const contentHashValue = await contentHash(content);
    const operationId = `OP-${crypto.randomUUID()}`;
    const pending: PendingCreate = {
        operationId,
        clientId: "C-test-client",
        type: "CREATE",
        path: "notes/own.md",
        base: { state: "UNKNOWN" },
        contentHash: contentHashValue,
        size: content.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "IN_FLIGHT",
    };
    const store = await ClientStore.open(
        `test-own-change-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(pending.path, content);
    await store.saveCreate(pending, new Blob([content]));
    const apply = new RemoteApply(store, new DownloadTransport(content), vault);

    const result = await apply.integrateChange("https://vaultdatum.test", {
        ...createChange(pending.path, contentHashValue, content.byteLength),
        operationId,
        actor: { type: "CLIENT", clientId: pending.clientId },
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await store.create(operationId), undefined);
    assert.equal(await store.hasConflict(pending.path), false);
    assert.equal((await store.replica(pending.path))?.revision, 1);
    store.close();
}

async function appliesARemoteDeleteToAMatchingReplica(): Promise<void> {
    const content = bytes("A note to remove");
    const hash = await contentHash(content);
    const store = await ClientStore.open(
        `test-remote-delete-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile("notes/delete.md", content);
    await store.putReplica({
        path: "notes/delete.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 4,
        contentHash: hash,
        size: content.byteLength,
    });
    const apply = new RemoteApply(store, new DownloadTransport(content), vault);

    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 5,
        type: "DELETE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path: "notes/delete.md",
                entryType: "FILE",
                state: "DELETED",
            },
        ],
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await vault.readFile("notes/delete.md"), undefined);
    assert.deepEqual(await store.replica("notes/delete.md"), {
        path: "notes/delete.md",
        entryType: "FILE",
        state: "DELETED",
        revision: 5,
    });
    store.close();
}

async function preservesAnOfflineModificationWhenTheServerDeletesItsBase(): Promise<void> {
    const path = "notes/delete-vs-modify.md";
    const initial = bytes("Initial server content");
    const modified = bytes("Offline local modification");
    const initialHash = await contentHash(initial);
    const store = await ClientStore.open(
        `test-delete-vs-modify-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, modified);
    await store.putReplica({
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision: 4,
        contentHash: initialHash,
        size: initial.byteLength,
    });
    const sync = new CreateSync(store, new NoopTransport(), vault, () => "");
    const pending = await sync.captureModify(path, modified);
    const apply = new RemoteApply(store, new NoopTransport(), vault);

    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 5,
        type: "DELETE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [{ path, entryType: "FILE", state: "DELETED" }],
    });

    assert.equal(pending?.type, "MODIFY");
    assert.equal(result.conflicted, 1);
    assert.equal(await vault.hash(path), await contentHash(modified));
    assert.equal((await store.replica(path))?.state, "DELETED");
    assert.equal(
        (await store.conflict(path))?.code,
        "REMOTE_CHANGE_OVERLAPS_PENDING",
    );
    assert.equal((await store.pendingForPath(path))?.status, "CONFLICT");
    store.close();
}

async function excludesObsidianConfigurationFromEventsAndReconciliation(): Promise<void> {
    const configurationPath = ".obsidian/workspace.json";
    const notePath = "notes/included.md";
    const configuration = bytes('{"local":true}');
    const note = bytes("Included content");
    const store = await ClientStore.open(
        `test-obsidian-exclusion-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(configurationPath, configuration);
    await vault.writeFile(notePath, note);
    const sync = new CreateSync(
        store,
        new FullReconciliationTransport(0, 0, [], new Map()),
        vault,
        () => "https://vaultdatum.test",
    );

    const captured = await sync.captureCreate(configurationPath, configuration);
    const summary = await sync.sync();

    assert.equal(captured, undefined);
    assert.equal(summary.conflicted, 0);
    assert.equal(summary.offline, true);
    assert.equal(await store.localScanBaseline(configurationPath), undefined);
    assert.equal(
        (await store.localScanBaseline(notePath))?.contentHash,
        await contentHash(note),
    );
    const pending = await store.pendingOperations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.type, "CREATE");
    assert.equal(pending[0]?.path, notePath);
    assert.equal(
        pending.some((operation) => operation.path === configurationPath),
        false,
    );
    store.close();
}

async function queuesModifyThenDeleteAgainstTheSameReplicaBase(): Promise<void> {
    const initial = bytes("Initial note");
    const initialHash = await contentHash(initial);
    const modified = bytes("Modified note");
    const store = await ClientStore.open(
        `test-local-mutations-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile("notes/local.md", initial);
    await store.putReplica({
        path: "notes/local.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 8,
        contentHash: initialHash,
        size: initial.byteLength,
    });
    const sync = new CreateSync(store, new NoopTransport(), vault, () => "");

    const modifiedOperation = await sync.captureModify(
        "notes/local.md",
        modified,
    );

    assert.equal(modifiedOperation?.type, "MODIFY");
    if (modifiedOperation?.type !== "MODIFY") {
        throw new Error("Expected a pending MODIFY operation");
    }
    const modify = modifiedOperation;
    assert.equal(modify.baseRevision, 8);
    assert.equal(modify.baseContentHash, initialHash);
    assert.equal(
        (await store.artifact(modify.artifactId)) instanceof Blob,
        true,
    );

    const deletedOperation = await sync.captureDelete("notes/local.md");

    assert.equal(deletedOperation?.type, "DELETE");
    assert.equal(deletedOperation?.baseRevision, 8);
    assert.equal(deletedOperation?.baseContentHash, initialHash);
    assert.equal(await store.operation(modify.operationId), undefined);
    store.close();
}

async function queuesAndObservesAnOwnRenameAsOneOperation(): Promise<void> {
    const sourcePath = "notes/rename-source.md";
    const destinationPath = "notes/rename-destination.md";
    const content = bytes("Rename this local file");
    const hash = await contentHash(content);
    const store = await ClientStore.open(
        `test-local-rename-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(sourcePath, content);
    await store.putReplica({
        path: sourcePath,
        entryType: "FILE",
        state: "PRESENT",
        revision: 8,
        contentHash: hash,
        size: content.byteLength,
    });
    const sync = new CreateSync(store, new NoopTransport(), vault, () => "");

    const pending = await sync.captureFilePathChange(
        sourcePath,
        destinationPath,
    );

    assert.equal(pending?.type, "RENAME");
    if (pending?.type !== "RENAME") {
        throw new Error("Expected a pending RENAME operation");
    }
    assert.equal(pending.path, sourcePath);
    assert.equal(pending.destinationPath, destinationPath);
    assert.equal(pending.baseRevision, 8);
    assert.equal(pending.baseContentHash, hash);

    await vault.removeFile(sourcePath);
    await vault.writeFile(destinationPath, content);
    const apply = new RemoteApply(store, new DownloadTransport(content), vault);
    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 9,
        type: "RENAME",
        operationId: pending.operationId,
        actor: { type: "CLIENT", clientId: pending.clientId },
        effects: [
            { path: sourcePath, entryType: "FILE", state: "DELETED" },
            {
                path: destinationPath,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: hash,
                size: content.byteLength,
            },
        ],
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await store.operation(pending.operationId), undefined);
    assert.equal((await store.replica(sourcePath))?.state, "DELETED");
    assert.equal((await store.replica(destinationPath))?.contentHash, hash);
    store.close();
}

async function queuesAndObservesAnOwnMoveAsOneOperation(): Promise<void> {
    const sourcePath = "notes/move-source.md";
    const destinationPath = "archive/move-destination.md";
    const content = bytes("Move this local file");
    const hash = await contentHash(content);
    const store = await ClientStore.open(
        `test-local-move-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(sourcePath, content);
    await store.putReplica({
        path: sourcePath,
        entryType: "FILE",
        state: "PRESENT",
        revision: 8,
        contentHash: hash,
        size: content.byteLength,
    });
    const sync = new CreateSync(store, new NoopTransport(), vault, () => "");

    const pending = await sync.captureFilePathChange(
        sourcePath,
        destinationPath,
    );

    assert.equal(pending?.type, "MOVE");
    if (pending?.type !== "MOVE") {
        throw new Error("Expected a pending MOVE operation");
    }
    assert.equal(pending.path, sourcePath);
    assert.equal(pending.destinationPath, destinationPath);
    assert.equal(pending.baseRevision, 8);
    assert.equal(pending.baseContentHash, hash);

    await vault.removeFile(sourcePath);
    await vault.writeFile(destinationPath, content);
    const apply = new RemoteApply(store, new DownloadTransport(content), vault);
    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 9,
        type: "MOVE",
        operationId: pending.operationId,
        actor: { type: "CLIENT", clientId: pending.clientId },
        effects: [
            { path: sourcePath, entryType: "FILE", state: "DELETED" },
            {
                path: destinationPath,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: hash,
                size: content.byteLength,
            },
        ],
    });

    assert.equal(result.conflicted, 0);
    assert.equal(await store.operation(pending.operationId), undefined);
    assert.equal((await store.replica(sourcePath))?.state, "DELETED");
    assert.equal((await store.replica(destinationPath))?.contentHash, hash);
    store.close();
}

async function reservesBothPathsWhileAMoveIsPending(): Promise<void> {
    const sourcePath = "notes/pending-move-source.md";
    const destinationPath = "archive/pending-move-destination.md";
    const store = await ClientStore.open(
        `test-pending-move-paths-${crypto.randomUUID()}`,
    );
    const pending: PendingMove = {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId: "C-pending-move",
        type: "MOVE",
        path: sourcePath,
        destinationPath,
        baseRevision: 4,
        baseContentHash: await contentHash(bytes("Base content")),
        createdAt: new Date().toISOString(),
        status: "READY",
    };
    await store.savePathChange(pending);

    assert.equal(
        (await store.findActiveOperation(sourcePath))?.operationId,
        pending.operationId,
    );
    assert.equal(
        (await store.findActiveOperation(destinationPath))?.operationId,
        pending.operationId,
    );
    assert.equal(
        (await store.pendingForPath(destinationPath))?.operationId,
        pending.operationId,
    );
    assert.equal(await store.hasStoredOperationForPath(destinationPath), true);
    store.close();
}

async function isolatesBothPathsWhenARemoteRenameOverlapsLocalContent(): Promise<void> {
    const sourcePath = "notes/remote-rename-source.md";
    const destinationPath = "archive/remote-rename-destination.md";
    const base = bytes("Base content");
    const local = bytes("Local unsynchronized content");
    const hash = await contentHash(base);
    const store = await ClientStore.open(
        `test-remote-rename-conflict-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(sourcePath, local);
    await store.putReplica({
        path: sourcePath,
        entryType: "FILE",
        state: "PRESENT",
        revision: 4,
        contentHash: hash,
        size: base.byteLength,
    });
    const apply = new RemoteApply(store, new DownloadTransport(base), vault);

    const result = await apply.integrateChange("https://vaultdatum.test", {
        revision: 5,
        type: "RENAME",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            { path: sourcePath, entryType: "FILE", state: "DELETED" },
            {
                path: destinationPath,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: hash,
                size: base.byteLength,
            },
        ],
    });

    assert.equal(result.conflicted, 2);
    assert.equal(await vault.hash(sourcePath), await contentHash(local));
    assert.equal(await vault.readFile(destinationPath), undefined);
    assert.equal(await store.hasConflict(sourcePath), true);
    assert.equal(await store.hasConflict(destinationPath), true);
    store.close();
}

async function pullsTheLatestContentAfterAnOwnIntermediateChange(): Promise<void> {
    const ownContent = bytes("Own first version");
    const ownHash = await contentHash(ownContent);
    const remoteContent = bytes("Remote later version");
    const remoteHash = await contentHash(remoteContent);
    const operationId = `OP-${crypto.randomUUID()}`;
    const pending: PendingCreate = {
        operationId,
        clientId: "C-own-client",
        type: "CREATE",
        path: "notes/history.md",
        base: { state: "UNKNOWN" },
        contentHash: ownHash,
        size: ownContent.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "IN_FLIGHT",
    };
    const store = await ClientStore.open(
        `test-history-compaction-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(pending.path, ownContent);
    await store.saveCreate(pending, new Blob([ownContent]));
    const changes: readonly RemoteChange[] = [
        {
            ...createChange(pending.path, ownHash, ownContent.byteLength),
            operationId,
            actor: { type: "CLIENT", clientId: pending.clientId },
        },
        {
            revision: 2,
            type: "MODIFY",
            operationId: `OP-${crypto.randomUUID()}`,
            actor: { type: "CLIENT", clientId: "C-remote-client" },
            effects: [
                {
                    path: pending.path,
                    entryType: "FILE",
                    state: "PRESENT",
                    contentHash: remoteHash,
                    size: remoteContent.byteLength,
                },
            ],
        },
    ];
    const sync = new CreateSync(
        store,
        new HistoryTransport(remoteContent, changes),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.deepEqual(summary, {
        committed: 0,
        conflicted: 0,
        oversized: 0,
        offline: false,
        vaultMismatch: false,
        initialBootstrap: true,
    });
    assert.equal(await vault.hash(pending.path), remoteHash);
    assert.equal((await store.syncState()).serverCursor, 2);
    assert.equal(await store.operation(operationId), undefined);
    assert.equal(await store.isInitialBootstrapComplete(), true);
    store.close();
}

async function retriesAnInFlightCreateAfterAStoreRestart(): Promise<void> {
    const path = "notes/offline.md";
    const content = bytes("Persisted while offline");
    const contentHashValue = await contentHash(content);
    const databaseName = `test-offline-retry-${crypto.randomUUID()}`;
    const firstStore = await ClientStore.open(databaseName);
    const vault = new MemoryVault();
    await vault.writeFile(path, content);
    const transport = new RetryingTransport(
        path,
        contentHashValue,
        content.byteLength,
    );
    const firstSync = new CreateSync(
        firstStore,
        transport,
        vault,
        () => "https://vaultdatum.test",
    );

    const captured = await firstSync.captureCreate(path, content);
    const firstSummary = await firstSync.sync();

    assert.equal(captured?.type, "CREATE");
    assert.equal(firstSummary.offline, true);
    assert.equal(
        (await firstStore.operation(captured?.operationId ?? ""))?.status,
        "IN_FLIGHT",
    );
    firstStore.close();

    const restartedStore = await ClientStore.open(databaseName);
    const restartedSync = new CreateSync(
        restartedStore,
        transport,
        vault,
        () => "https://vaultdatum.test",
    );
    const restartedSummary = await restartedSync.sync();

    assert.deepEqual(restartedSummary, {
        committed: 1,
        conflicted: 0,
        oversized: 0,
        offline: false,
        vaultMismatch: false,
    });
    assert.equal(
        await restartedStore.operation(captured?.operationId ?? ""),
        undefined,
    );
    assert.equal((await restartedStore.syncState()).serverCursor, 1);
    restartedStore.close();
}

async function continuesPullingUnrelatedPathsAfterAConflict(): Promise<void> {
    const conflictPath = "notes/conflicted.md";
    const localConflict = bytes("Local conflicting content");
    const remoteConflict = bytes("Remote conflicting content");
    const cleanPath = "notes/clean.md";
    const cleanContent = bytes("Remote clean content");
    const store = await ClientStore.open(
        `test-conflict-isolation-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(conflictPath, localConflict);
    const changes: readonly RemoteChange[] = [
        {
            revision: 1,
            type: "CREATE",
            operationId: `OP-${crypto.randomUUID()}`,
            actor: { type: "CLIENT", clientId: "C-remote-client" },
            effects: [
                {
                    path: conflictPath,
                    entryType: "FILE",
                    state: "PRESENT",
                    contentHash: await contentHash(remoteConflict),
                    size: remoteConflict.byteLength,
                },
            ],
        },
        {
            revision: 2,
            type: "CREATE",
            operationId: `OP-${crypto.randomUUID()}`,
            actor: { type: "CLIENT", clientId: "C-remote-client" },
            effects: [
                {
                    path: cleanPath,
                    entryType: "FILE",
                    state: "PRESENT",
                    contentHash: await contentHash(cleanContent),
                    size: cleanContent.byteLength,
                },
            ],
        },
    ];
    const sync = new CreateSync(
        store,
        new HistoryTransport(cleanContent, changes),
        vault,
        () => "https://vaultdatum.test",
    );

    const summary = await sync.sync();

    assert.deepEqual(summary, {
        committed: 0,
        conflicted: 1,
        oversized: 0,
        offline: false,
        vaultMismatch: false,
        initialBootstrap: true,
    });
    assert.equal(
        await vault.hash(conflictPath),
        await contentHash(localConflict),
    );
    assert.equal(await vault.hash(cleanPath), await contentHash(cleanContent));
    assert.equal(await store.hasConflict(conflictPath), true);
    assert.equal((await store.syncState()).serverCursor, 2);
    store.close();
}

async function explicitlyResolvesAConflictByUsingTheServerVersion(): Promise<void> {
    const path = "notes/resolve.md";
    const localContent = bytes("Local pending content");
    const remoteContent = bytes("Server selected content");
    const localHash = await contentHash(localContent);
    const remoteHash = await contentHash(remoteContent);
    const pending: PendingCreate = {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId: "C-local-client",
        type: "CREATE",
        path,
        base: { state: "UNKNOWN" },
        contentHash: localHash,
        size: localContent.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "READY",
    };
    const store = await ClientStore.open(
        `test-use-server-resolution-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveCreate(pending, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    const integrated = await apply.integrateChange("https://vaultdatum.test", {
        revision: 4,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });

    assert.equal(integrated.conflicted, 1);
    assert.equal(
        (await store.operation(pending.operationId))?.status,
        "CONFLICT",
    );

    const resolved = await apply.resolveUseServer(
        "https://vaultdatum.test",
        path,
    );

    assert.equal(resolved, true);
    assert.equal(await vault.hash(path), remoteHash);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(pending.operationId), undefined);
    assert.equal(await store.artifact(pending.artifactId), undefined);
    store.close();
}

async function explicitlyResolvesAConflictByApplyingTheLocalVersion(): Promise<void> {
    const path = "notes/apply-local.md";
    const localContent = bytes("Local selected content");
    const remoteContent = bytes("Server conflicting content");
    const localHash = await contentHash(localContent);
    const remoteHash = await contentHash(remoteContent);
    const discarded: PendingCreate = {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId: "C-local-client",
        type: "CREATE",
        path,
        base: { state: "UNKNOWN" },
        contentHash: localHash,
        size: localContent.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "READY",
    };
    const store = await ClientStore.open(
        `test-apply-local-resolution-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveCreate(discarded, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 7,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });

    const resolved = await apply.resolveApplyLocal(path);
    const pending = await store.pendingForPath(path);

    assert.equal(resolved, true);
    assert.equal(await vault.hash(path), localHash);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(discarded.operationId), undefined);
    assert.equal(await store.artifact(discarded.artifactId), undefined);
    assert.equal(pending?.type, "MODIFY");
    if (pending?.type !== "MODIFY") {
        throw new Error("Expected a pending MODIFY operation");
    }
    assert.equal(pending.baseRevision, 7);
    assert.equal(pending.baseContentHash, remoteHash);
    assert.equal(pending.contentHash, localHash);
    assert.equal(
        (await store.artifact(pending.artifactId)) instanceof Blob,
        true,
    );
    store.close();
}

async function explicitlyResolvesAConflictByKeepingTheLocalDeletion(): Promise<void> {
    const path = "notes/keep-deleted.md";
    const priorHash = await contentHash(bytes("Prior content"));
    const remoteContent = bytes("Server recreated content");
    const remoteHash = await contentHash(remoteContent);
    const discarded: PendingDelete = {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId: "C-local-client",
        type: "DELETE",
        path,
        baseRevision: 2,
        baseContentHash: priorHash,
        createdAt: new Date().toISOString(),
        status: "READY",
    };
    const store = await ClientStore.open(
        `test-keep-deleted-resolution-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await store.saveDelete(discarded);
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 9,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });

    const resolved = await apply.resolveKeepDeleted(path);
    const pending = await store.pendingForPath(path);

    assert.equal(resolved, true);
    assert.equal(await vault.readFile(path), undefined);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(discarded.operationId), undefined);
    assert.equal(pending?.type, "DELETE");
    if (pending?.type !== "DELETE") {
        throw new Error("Expected a pending DELETE operation");
    }
    assert.equal(pending.baseRevision, 9);
    assert.equal(pending.baseContentHash, remoteHash);
    store.close();
}

async function explicitlyResolvesAConflictByRestoringLocalContent(): Promise<void> {
    const path = "notes/restore-local.md";
    const localContent = bytes("Local content to restore");
    const localHash = await contentHash(localContent);
    const discarded: PendingModify = {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId: "C-local-client",
        type: "MODIFY",
        path,
        baseRevision: 3,
        baseContentHash: await contentHash(bytes("Original server content")),
        contentHash: localHash,
        size: localContent.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "READY",
    };
    const store = await ClientStore.open(
        `test-restore-local-resolution-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveContentOperation(discarded, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(localContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 11,
        type: "DELETE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "DELETED",
            },
        ],
    });

    const resolved = await apply.resolveRestoreLocal(path);
    const pending = await store.pendingForPath(path);

    assert.equal(resolved, true);
    assert.equal(await vault.hash(path), localHash);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(discarded.operationId), undefined);
    assert.equal(await store.artifact(discarded.artifactId), undefined);
    assert.equal(pending?.type, "CREATE");
    if (pending?.type !== "CREATE") {
        throw new Error("Expected a pending CREATE operation");
    }
    assert.deepEqual(pending.base, { state: "DELETED", revision: 11 });
    assert.equal(pending.contentHash, localHash);
    assert.equal(
        (await store.artifact(pending.artifactId)) instanceof Blob,
        true,
    );
    store.close();
}

async function explicitlyResolvesACreateConflictByKeepingBothFiles(): Promise<void> {
    const path = "notes/keep-both.md";
    const destinationPath = "notes/keep-both (conflict copy).md";
    const localContent = bytes("Local copy to preserve");
    const remoteContent = bytes("Server copy to keep");
    const localHash = await contentHash(localContent);
    const remoteHash = await contentHash(remoteContent);
    const source = await pendingCreate(path, localContent, "C-local-client");
    const store = await ClientStore.open(
        `test-keep-both-resolution-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveCreate(source, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 12,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });

    const resolved = await apply.resolveKeepBoth(
        "https://vaultdatum.test",
        path,
        destinationPath,
    );
    const pending = await store.pendingForPath(destinationPath);

    assert.equal(resolved, true);
    assert.equal(await vault.hash(path), remoteHash);
    assert.equal(await vault.hash(destinationPath), localHash);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(source.operationId), undefined);
    assert.equal(await store.artifact(source.artifactId), undefined);
    assert.equal((await store.keepBothResolutions()).length, 0);
    assert.equal(pending?.type, "CREATE");
    if (pending?.type !== "CREATE") {
        throw new Error(
            "Expected a pending CREATE operation for the local copy",
        );
    }
    assert.deepEqual(pending.base, { state: "UNKNOWN" });
    assert.equal(pending.contentHash, localHash);
    assert.equal(
        (await store.artifact(pending.artifactId)) instanceof Blob,
        true,
    );
    store.close();
}

async function resumesAnInterruptedKeepBothResolution(): Promise<void> {
    const path = "notes/keep-both-recovery.md";
    const destinationPath = "notes/keep-both-recovery (conflict copy).md";
    const localContent = bytes("Durable local copy");
    const remoteContent = bytes("Durable server copy");
    const localHash = await contentHash(localContent);
    const remoteHash = await contentHash(remoteContent);
    const source = await pendingCreate(path, localContent, "C-local-client");
    const copy = await pendingCreate(
        destinationPath,
        localContent,
        "C-local-client",
    );
    const resolution: KeepBothResolution = {
        resolutionId: `keep-both-${crypto.randomUUID()}`,
        sourcePath: path,
        pending: copy,
        phase: "COPYING",
    };
    const store = await ClientStore.open(
        `test-keep-both-recovery-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveCreate(source, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 13,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });
    await store.beginKeepBothResolution(resolution, new Blob([localContent]));

    await apply.recoverKeepBothResolutions("https://vaultdatum.test");
    const pending = await store.pendingForPath(destinationPath);

    assert.equal(await vault.hash(path), remoteHash);
    assert.equal(await vault.hash(destinationPath), localHash);
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(source.operationId), undefined);
    assert.equal((await store.keepBothResolutions()).length, 0);
    assert.equal(pending?.operationId, copy.operationId);
    assert.equal((await store.artifact(copy.artifactId)) instanceof Blob, true);
    store.close();
}

async function manuallyMergesAMarkdownConflict(): Promise<void> {
    const path = "notes/manual-merge.md";
    const localContent = bytes("Local version");
    const remoteContent = bytes("Server version");
    const mergedContent = bytes("Merged version");
    const localHash = await contentHash(localContent);
    const remoteHash = await contentHash(remoteContent);
    const source = await pendingModify(path, localContent, "C-local-client");
    const store = await ClientStore.open(
        `test-manual-merge-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveContentOperation(source, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 14,
        type: "MODIFY",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });

    const versions = await apply.manualMergeVersions(
        "https://vaultdatum.test",
        path,
    );
    const resolved = await apply.resolveManualMerge(path, mergedContent);
    const pending = await store.pendingForPath(path);

    assert.equal(new TextDecoder().decode(versions.server), "Server version");
    assert.equal(new TextDecoder().decode(versions.local), "Local version");
    assert.equal(resolved, true);
    assert.equal(await vault.hash(path), await contentHash(mergedContent));
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(source.operationId), undefined);
    assert.equal(await store.artifact(source.artifactId), undefined);
    assert.equal((await store.manualMergeResolutions()).length, 0);
    assert.equal(pending?.type, "MODIFY");
    if (pending?.type !== "MODIFY") {
        throw new Error("Expected a pending MODIFY operation for the merge");
    }
    assert.equal(pending.baseRevision, 14);
    assert.equal(pending.baseContentHash, remoteHash);
    assert.equal(pending.contentHash, await contentHash(mergedContent));
    assert.notEqual(localHash, pending.contentHash);
    store.close();
}

async function resumesAnInterruptedManualMerge(): Promise<void> {
    const path = "notes/manual-merge-recovery.md";
    const localContent = bytes("Local before merge");
    const remoteContent = bytes("Server before merge");
    const mergedContent = bytes("Durable merged result");
    const remoteHash = await contentHash(remoteContent);
    const source = await pendingModify(path, localContent, "C-local-client");
    const pending = await pendingModify(path, mergedContent, "C-local-client");
    const resolution: ManualMergeResolution = {
        resolutionId: `manual-merge-${crypto.randomUUID()}`,
        path,
        sourceContentHash: await contentHash(localContent),
        pending: {
            ...pending,
            baseRevision: 15,
            baseContentHash: remoteHash,
        },
    };
    const store = await ClientStore.open(
        `test-manual-merge-recovery-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    await vault.writeFile(path, localContent);
    await store.saveContentOperation(source, new Blob([localContent]));
    const apply = new RemoteApply(
        store,
        new DownloadTransport(remoteContent),
        vault,
    );

    await apply.integrateChange("https://vaultdatum.test", {
        revision: 15,
        type: "MODIFY",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: remoteHash,
                size: remoteContent.byteLength,
            },
        ],
    });
    await store.beginManualMergeResolution(
        resolution,
        new Blob([mergedContent]),
    );

    await apply.recoverManualMergeResolutions();

    assert.equal(await vault.hash(path), await contentHash(mergedContent));
    assert.equal(await store.hasConflict(path), false);
    assert.equal(await store.operation(source.operationId), undefined);
    assert.equal((await store.manualMergeResolutions()).length, 0);
    assert.equal(
        (await store.pendingForPath(path))?.operationId,
        resolution.pending.operationId,
    );
    store.close();
}

class DownloadTransport implements ContentTransport {
    public constructor(private readonly content: ArrayBuffer) {}

    public async downloadContent(
        serverUrl: string,
        path: string,
        revision: number,
        contentHashValue: string,
    ) {
        void serverUrl;
        void path;
        void revision;
        void contentHashValue;
        return { kind: "OK" as const, value: this.content.slice(0) };
    }
}

class NoopTransport implements SyncTransport {
    public async readVault(
        serverUrl: string,
    ): Promise<ReadResult<RemoteVaultInfo>> {
        void serverUrl;
        return { kind: "UNAVAILABLE" };
    }

    public async createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>> {
        void serverUrl;
        return { kind: "UNAVAILABLE" };
    }

    public async readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>> {
        void serverUrl;
        void manifestId;
        return { kind: "UNAVAILABLE" };
    }

    public async listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>> {
        void serverUrl;
        void after;
        void limit;
        return { kind: "UNAVAILABLE" };
    }

    public async downloadContent(
        serverUrl: string,
        path: string,
        revision: number,
        contentHashValue: string,
    ): Promise<ReadResult<ArrayBuffer>> {
        void serverUrl;
        void path;
        void revision;
        void contentHashValue;
        return { kind: "UNAVAILABLE" };
    }

    public async submitCreate(
        serverUrl: string,
        pending: PendingCreate,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        void content;
        return { kind: "UNAVAILABLE" };
    }

    public async submitModify(
        serverUrl: string,
        pending: PendingModify,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        void content;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDelete(
        serverUrl: string,
        pending: PendingDelete,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitRename(
        serverUrl: string,
        pending: PendingRename,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitMove(
        serverUrl: string,
        pending: PendingMove,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryCreate(
        serverUrl: string,
        pending: PendingDirectoryCreate,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryDelete(
        serverUrl: string,
        pending: PendingDirectoryDelete,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryRename(
        serverUrl: string,
        pending: PendingDirectoryRename,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryMove(
        serverUrl: string,
        pending: PendingDirectoryMove,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }
}

class HistoryTransport extends DownloadTransport implements SyncTransport {
    public constructor(
        content: ArrayBuffer,
        private readonly changes: readonly RemoteChange[],
    ) {
        super(content);
    }

    public async readVault(
        serverUrl: string,
    ): Promise<ReadResult<RemoteVaultInfo>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                vaultId: "V-test-vault",
                currentRevision: 2,
                oldestRetainedRevision: 0,
                protocolVersion: 1,
                hashAlgorithm: "SHA-256",
            },
        };
    }

    public async createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                manifestId: "M-history",
                vaultId: "V-test-vault",
                snapshotRevision: 2,
                expiresAt: "2030-01-01T00:00:00Z",
            },
        };
    }

    public async readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>> {
        void serverUrl;
        if (manifestId !== "M-history") {
            return { kind: "MANIFEST_EXPIRED" };
        }
        return {
            kind: "OK",
            value: {
                manifestId,
                vaultId: "V-test-vault",
                snapshotRevision: 2,
                expiresAt: "2030-01-01T00:00:00Z",
                entries: this.manifestEntries(),
            },
        };
    }

    public async listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>> {
        void serverUrl;
        void limit;
        return {
            kind: "OK",
            value: {
                vaultId: "V-test-vault",
                fromExclusive: after,
                toInclusive: 2,
                currentRevision: 2,
                hasMore: false,
                changes: this.changes.filter(
                    (change) => change.revision > after,
                ),
            },
        };
    }

    public async submitCreate(
        serverUrl: string,
        pending: PendingCreate,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        void content;
        return { kind: "UNAVAILABLE" };
    }

    public async submitModify(
        serverUrl: string,
        pending: PendingModify,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        void content;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDelete(
        serverUrl: string,
        pending: PendingDelete,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitRename(
        serverUrl: string,
        pending: PendingRename,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitMove(
        serverUrl: string,
        pending: PendingMove,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryCreate(
        serverUrl: string,
        pending: PendingDirectoryCreate,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryDelete(
        serverUrl: string,
        pending: PendingDirectoryDelete,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryRename(
        serverUrl: string,
        pending: PendingDirectoryRename,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    public async submitDirectoryMove(
        serverUrl: string,
        pending: PendingDirectoryMove,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void pending;
        return { kind: "UNAVAILABLE" };
    }

    private manifestEntries(): readonly RemoteManifestEntry[] {
        const entries = new Map<string, RemoteManifestEntry>();
        for (const change of this.changes) {
            for (const effect of change.effects) {
                if (effect.state === "DELETED") {
                    entries.set(effect.path, {
                        path: effect.path,
                        entryType: effect.entryType,
                        state: "DELETED",
                        revision: change.revision,
                    });
                    continue;
                }
                if (
                    effect.entryType === "FILE" &&
                    effect.contentHash !== undefined &&
                    effect.size !== undefined
                ) {
                    entries.set(effect.path, {
                        path: effect.path,
                        entryType: "FILE",
                        state: "PRESENT",
                        revision: change.revision,
                        contentHash: effect.contentHash,
                        size: effect.size,
                    });
                    continue;
                }
                entries.set(effect.path, {
                    path: effect.path,
                    entryType: "DIRECTORY",
                    state: "PRESENT",
                    revision: change.revision,
                });
            }
        }
        return [...entries.values()];
    }
}

class ManifestTransport extends NoopTransport {
    public manifestCreates = 0;

    public manifestReads = 0;

    private manifestCreated = false;

    public constructor(
        private readonly path: string,
        private readonly snapshotContent: ArrayBuffer,
        private readonly laterChange?: RemoteChange,
        private readonly laterContent?: ArrayBuffer,
    ) {
        super();
    }

    public override async readVault(
        serverUrl: string,
    ): Promise<ReadResult<RemoteVaultInfo>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                vaultId: "V-manifest-test",
                currentRevision:
                    this.manifestCreated && this.laterChange !== undefined
                        ? this.laterChange.revision
                        : 1,
                oldestRetainedRevision: 0,
                protocolVersion: 1,
                hashAlgorithm: "SHA-256",
            },
        };
    }

    public override async createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>> {
        void serverUrl;
        this.manifestCreated = true;
        this.manifestCreates += 1;
        return {
            kind: "OK",
            value: {
                manifestId: "M-manifest-test",
                vaultId: "V-manifest-test",
                snapshotRevision: 1,
                expiresAt: "2030-01-01T00:00:00Z",
            },
        };
    }

    public override async readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>> {
        void serverUrl;
        this.manifestReads += 1;
        if (manifestId !== "M-manifest-test") {
            return { kind: "MANIFEST_EXPIRED" };
        }
        const snapshotHash = await contentHash(this.snapshotContent);
        return {
            kind: "OK",
            value: {
                manifestId,
                vaultId: "V-manifest-test",
                snapshotRevision: 1,
                expiresAt: "2030-01-01T00:00:00Z",
                entries: [
                    {
                        path: this.path,
                        entryType: "FILE",
                        state: "PRESENT",
                        revision: 1,
                        contentHash: snapshotHash,
                        size: this.snapshotContent.byteLength,
                    },
                ],
            },
        };
    }

    public override async listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>> {
        void serverUrl;
        void limit;
        const currentRevision =
            this.manifestCreated && this.laterChange !== undefined
                ? this.laterChange.revision
                : 1;
        return {
            kind: "OK",
            value: {
                vaultId: "V-manifest-test",
                fromExclusive: after,
                toInclusive: currentRevision,
                currentRevision,
                hasMore: false,
                changes:
                    this.laterChange !== undefined &&
                    after < this.laterChange.revision
                        ? [this.laterChange]
                        : [],
            },
        };
    }

    public override async downloadContent(
        serverUrl: string,
        path: string,
        revision: number,
        contentHashValue: string,
    ): Promise<ReadResult<ArrayBuffer>> {
        void serverUrl;
        if (path !== this.path) {
            return { kind: "STATE_CHANGED" };
        }
        if (
            revision === 1 &&
            contentHashValue === (await contentHash(this.snapshotContent))
        ) {
            return { kind: "OK", value: this.snapshotContent.slice(0) };
        }
        if (
            this.laterChange?.effects[0]?.contentHash === contentHashValue &&
            this.laterContent !== undefined
        ) {
            return { kind: "OK", value: this.laterContent.slice(0) };
        }
        return { kind: "STATE_CHANGED" };
    }
}

class FullReconciliationTransport extends NoopTransport {
    public constructor(
        private readonly currentRevision: number,
        private readonly snapshotRevision: number,
        private readonly entries: readonly RemoteManifestEntry[],
        private readonly content: ReadonlyMap<string, ArrayBuffer>,
        private readonly historyUnavailable = false,
    ) {
        super();
    }

    public override async readVault(
        serverUrl: string,
    ): Promise<ReadResult<RemoteVaultInfo>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                vaultId: "V-reconciliation",
                currentRevision: this.currentRevision,
                oldestRetainedRevision: 0,
                protocolVersion: 1,
                hashAlgorithm: "SHA-256",
            },
        };
    }

    public override async createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                manifestId: "M-reconciliation",
                vaultId: "V-reconciliation",
                snapshotRevision: this.snapshotRevision,
                expiresAt: "2030-01-01T00:00:00Z",
            },
        };
    }

    public override async readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>> {
        void serverUrl;
        if (manifestId !== "M-reconciliation") {
            return { kind: "MANIFEST_EXPIRED" };
        }
        return {
            kind: "OK",
            value: {
                manifestId,
                vaultId: "V-reconciliation",
                snapshotRevision: this.snapshotRevision,
                expiresAt: "2030-01-01T00:00:00Z",
                entries: this.entries,
            },
        };
    }

    public override async listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>> {
        void serverUrl;
        void limit;
        if (this.historyUnavailable && after < this.currentRevision) {
            return { kind: "HISTORY_NOT_AVAILABLE" };
        }
        return {
            kind: "OK",
            value: {
                vaultId: "V-reconciliation",
                fromExclusive: after,
                toInclusive: after,
                currentRevision: this.currentRevision,
                hasMore: false,
                changes: [],
            },
        };
    }

    public override async downloadContent(
        serverUrl: string,
        path: string,
        revision: number,
        contentHashValue: string,
    ): Promise<ReadResult<ArrayBuffer>> {
        void serverUrl;
        void revision;
        const content = this.content.get(path);
        if (
            content === undefined ||
            (await contentHash(content)) !== contentHashValue
        ) {
            return { kind: "STATE_CHANGED" };
        }
        return { kind: "OK", value: content.slice(0) };
    }
}

class RetryingTransport extends NoopTransport {
    private available = false;

    private committed = false;

    private change: RemoteChange | undefined;

    public constructor(
        private readonly path: string,
        private readonly contentHashValue: string,
        private readonly size: number,
    ) {
        super();
    }

    public override async readVault(
        serverUrl: string,
    ): Promise<ReadResult<RemoteVaultInfo>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                vaultId: "V-offline-retry",
                currentRevision: this.committed ? 1 : 0,
                oldestRetainedRevision: 0,
                protocolVersion: 1,
                hashAlgorithm: "SHA-256",
            },
        };
    }

    public override async createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>> {
        void serverUrl;
        return {
            kind: "OK",
            value: {
                manifestId: "M-offline-retry",
                vaultId: "V-offline-retry",
                snapshotRevision: this.committed ? 1 : 0,
                expiresAt: "2030-01-01T00:00:00Z",
            },
        };
    }

    public override async readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>> {
        void serverUrl;
        if (manifestId !== "M-offline-retry") {
            return { kind: "MANIFEST_EXPIRED" };
        }
        return {
            kind: "OK",
            value: {
                manifestId,
                vaultId: "V-offline-retry",
                snapshotRevision: this.committed ? 1 : 0,
                expiresAt: "2030-01-01T00:00:00Z",
                entries: this.committed
                    ? [
                          {
                              path: this.path,
                              entryType: "FILE",
                              state: "PRESENT",
                              revision: 1,
                              contentHash: this.contentHashValue,
                              size: this.size,
                          },
                      ]
                    : [],
            },
        };
    }

    public override async listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>> {
        void serverUrl;
        void limit;
        return {
            kind: "OK",
            value: {
                vaultId: "V-offline-retry",
                fromExclusive: after,
                toInclusive: this.committed ? 1 : after,
                currentRevision: this.committed ? 1 : 0,
                hasMore: false,
                changes:
                    this.change === undefined || after >= this.change.revision
                        ? []
                        : [this.change],
            },
        };
    }

    public override async submitCreate(
        serverUrl: string,
        pending: PendingCreate,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        void serverUrl;
        void content;
        if (!this.available) {
            this.available = true;
            return { kind: "UNAVAILABLE" };
        }

        this.committed = true;
        this.change = {
            revision: 1,
            type: "CREATE",
            operationId: pending.operationId,
            actor: { type: "CLIENT", clientId: pending.clientId },
            effects: [
                {
                    path: this.path,
                    entryType: "FILE",
                    state: "PRESENT",
                    contentHash: this.contentHashValue,
                    size: this.size,
                },
            ],
        };
        return {
            kind: "COMMITTED",
            result: {
                operationId: pending.operationId,
                status: "COMMITTED",
                resultRevision: 1,
                replayed: false,
            },
        };
    }
}

class MemoryVault implements LocalVault {
    private readonly files = new Map<string, ArrayBuffer>();

    private readonly directories = new Set<string>();

    public async listFiles(): Promise<
        readonly { readonly path: string; readonly size: number }[]
    > {
        return [...this.files.entries()]
            .map(([path, content]) => ({ path, size: content.byteLength }))
            .sort((left, right) => left.path.localeCompare(right.path));
    }

    public async listDirectories(): Promise<readonly string[]> {
        return [...this.directories].sort((left, right) =>
            left.localeCompare(right),
        );
    }

    public async fileSize(path: string): Promise<number | undefined> {
        return this.files.get(path)?.byteLength;
    }

    public async readFile(path: string): Promise<ArrayBuffer | undefined> {
        return this.files.get(path)?.slice(0);
    }

    public async writeFile(path: string, content: ArrayBuffer): Promise<void> {
        this.createParentDirectories(path);
        this.files.set(path, content.slice(0));
    }

    public async removeFile(path: string): Promise<void> {
        this.files.delete(path);
    }

    public async directoryExists(path: string): Promise<boolean> {
        return this.directories.has(path);
    }

    public async directoryIsEmpty(path: string): Promise<boolean> {
        if (!this.directories.has(path)) {
            return false;
        }
        const prefix = `${path}/`;
        return ![...this.files.keys(), ...this.directories].some((candidate) =>
            candidate.startsWith(prefix),
        );
    }

    public async createDirectory(path: string): Promise<void> {
        if (this.files.has(path)) {
            throw new Error("Cannot replace a file with a directory");
        }
        this.createParentDirectories(path);
        this.directories.add(path);
    }

    public async removeDirectory(path: string): Promise<void> {
        if (!(await this.directoryIsEmpty(path))) {
            throw new Error("Cannot remove a non-empty directory");
        }
        this.directories.delete(path);
    }

    public async hash(path: string): Promise<string | undefined> {
        const content = await this.readFile(path);
        return content === undefined ? undefined : contentHash(content);
    }

    private createParentDirectories(path: string): void {
        const segments = path.split("/");
        let current = "";

        for (const segment of segments.slice(0, -1)) {
            current = current.length === 0 ? segment : `${current}/${segment}`;
            if (this.files.has(current)) {
                throw new Error("Cannot create a directory over a file");
            }
            this.directories.add(current);
        }
    }
}

class FaultingMemoryVault extends MemoryVault {
    private nextWriteFailure: "BEFORE" | "AFTER" | undefined;

    public failBeforeNextWrite(): void {
        this.nextWriteFailure = "BEFORE";
    }

    public failAfterNextWrite(): void {
        this.nextWriteFailure = "AFTER";
    }

    public override async writeFile(
        path: string,
        content: ArrayBuffer,
    ): Promise<void> {
        const failure = this.nextWriteFailure;
        this.nextWriteFailure = undefined;
        if (failure === "BEFORE") {
            throw new Error("Simulated write failure before local mutation");
        }

        await super.writeFile(path, content);
        if (failure === "AFTER") {
            throw new Error("Simulated write failure after local mutation");
        }
    }
}

function createChange(
    path: string,
    contentHashValue: string,
    size: number,
): RemoteChange {
    return {
        revision: 1,
        type: "CREATE",
        operationId: `OP-${crypto.randomUUID()}`,
        actor: { type: "CLIENT", clientId: "C-remote-client" },
        effects: [
            {
                path,
                entryType: "FILE",
                state: "PRESENT",
                contentHash: contentHashValue,
                size,
            },
        ],
    };
}

function presentManifestEntry(
    path: string,
    revision: number,
    contentHashValue: string,
    size: number,
): RemoteManifestEntry {
    return {
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision,
        contentHash: contentHashValue,
        size,
    };
}

function deletedManifestEntry(
    path: string,
    revision: number,
): RemoteManifestEntry {
    return {
        path,
        entryType: "FILE",
        state: "DELETED",
        revision,
    };
}

function bytes(value: string): ArrayBuffer {
    return new TextEncoder().encode(value).buffer;
}

async function pendingCreate(
    path: string,
    content: ArrayBuffer,
    clientId: string,
): Promise<PendingCreate> {
    return {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId,
        type: "CREATE",
        path,
        base: { state: "UNKNOWN" },
        contentHash: await contentHash(content),
        size: content.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "READY",
    };
}

async function pendingModify(
    path: string,
    content: ArrayBuffer,
    clientId: string,
): Promise<PendingModify> {
    return {
        operationId: `OP-${crypto.randomUUID()}`,
        clientId,
        type: "MODIFY",
        path,
        baseRevision: 1,
        baseContentHash: await contentHash(bytes("Initial server content")),
        contentHash: await contentHash(content),
        size: content.byteLength,
        artifactId: `artifact-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: "READY",
    };
}

await appliesARemoteCreateToAnEmptyVault();
await appliesABinaryAttachmentWithoutTextConversion();
await appliesAnEmptyRemoteDirectory();
await appliesAnEmptyRemoteDirectoryDelete();
await queuesAnEmptyLocalDirectory();
await observesAnOwnDirectoryMove();
await preservesANonEmptyLocalDirectoryDuringARemoteMove();
await refusesToQueueContentAboveTheAttachmentLimit();
await skipsOversizedAttachmentsDuringReconciliation();
await refusesAnOversizedRemoteAttachmentBeforeDownloading();
await initializesFromAManifestAndCatchesUpLaterChanges();
await preservesExistingLocalContentDuringInitialManifestSync();
await recoversAMissedLocalModificationDuringIntegrityScan();
await preservesAMissedLocalDeletionDuringInitialBootstrap();
await queuesInitialUntrackedFilesAfterServerManifest();
await doesNotCompleteBootstrapWhileTheServerIsUnavailable();
await quarantinesAFileThatReappearsAfterServerDeletion();
await repairsAMissingReplicaEntryFromTheServerManifest();
await preservesLocalContentWhenManifestDeletionOverlapsMissedEdit();
await fallsBackToAManifestWhenHistoryIsUnavailable();
await discardsAnApplyInterruptedBeforeContentIsStaged();
await resumesAStagedApplyAfterRestartBeforeLocalWrite();
await finalizesAnApplyAfterLocalWriteBeforeMetadataFinalization();
await preservesUnexpectedLocalContentDuringApplyRecovery();
await preservesAnExistingLocalFileAsAConflict();
await integratesAnOwnChangeAfterTheOperationResponseWasLost();
await appliesARemoteDeleteToAMatchingReplica();
await preservesAnOfflineModificationWhenTheServerDeletesItsBase();
await excludesObsidianConfigurationFromEventsAndReconciliation();
await queuesModifyThenDeleteAgainstTheSameReplicaBase();
await queuesAndObservesAnOwnRenameAsOneOperation();
await queuesAndObservesAnOwnMoveAsOneOperation();
await reservesBothPathsWhileAMoveIsPending();
await isolatesBothPathsWhenARemoteRenameOverlapsLocalContent();
await pullsTheLatestContentAfterAnOwnIntermediateChange();
await retriesAnInFlightCreateAfterAStoreRestart();
await continuesPullingUnrelatedPathsAfterAConflict();
await explicitlyResolvesAConflictByUsingTheServerVersion();
await explicitlyResolvesAConflictByApplyingTheLocalVersion();
await explicitlyResolvesAConflictByKeepingTheLocalDeletion();
await explicitlyResolvesAConflictByRestoringLocalContent();
await explicitlyResolvesACreateConflictByKeepingBothFiles();
await resumesAnInterruptedKeepBothResolution();
await manuallyMergesAMarkdownConflict();
await resumesAnInterruptedManualMerge();
