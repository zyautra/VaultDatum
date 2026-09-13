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
