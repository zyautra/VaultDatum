import "fake-indexeddb/auto";

import assert from "node:assert/strict";

import { contentHash } from "../src/core/content-hash";
import {
    ClientStore,
    type PendingCreate,
    type PendingDelete,
    type PendingModify,
} from "../src/storage/client-store";
import { CreateSync } from "../src/sync/create-sync";
import { type LocalVault, RemoteApply } from "../src/sync/remote-apply";
import type {
    ContentTransport,
    ReadResult,
    RemoteChange,
    RemoteChangePage,
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
        offline: false,
        vaultMismatch: false,
    });
    assert.equal(await vault.hash(pending.path), remoteHash);
    assert.equal((await store.syncState()).serverCursor, 2);
    assert.equal(await store.operation(operationId), undefined);
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
        offline: false,
        vaultMismatch: false,
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

    public async readFile(path: string): Promise<ArrayBuffer | undefined> {
        return this.files.get(path)?.slice(0);
    }

    public async writeFile(path: string, content: ArrayBuffer): Promise<void> {
        this.files.set(path, content.slice(0));
    }

    public async removeFile(path: string): Promise<void> {
        this.files.delete(path);
    }

    public async hash(path: string): Promise<string | undefined> {
        const content = await this.readFile(path);
        return content === undefined ? undefined : contentHash(content);
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

function bytes(value: string): ArrayBuffer {
    return new TextEncoder().encode(value).buffer;
}

await appliesARemoteCreateToAnEmptyVault();
await preservesAnExistingLocalFileAsAConflict();
await integratesAnOwnChangeAfterTheOperationResponseWasLost();
await appliesARemoteDeleteToAMatchingReplica();
await queuesModifyThenDeleteAgainstTheSameReplicaBase();
await pullsTheLatestContentAfterAnOwnIntermediateChange();
await retriesAnInFlightCreateAfterAStoreRestart();
await continuesPullingUnrelatedPathsAfterAConflict();
await explicitlyResolvesAConflictByUsingTheServerVersion();
await explicitlyResolvesAConflictByApplyingTheLocalVersion();
await explicitlyResolvesAConflictByKeepingTheLocalDeletion();
