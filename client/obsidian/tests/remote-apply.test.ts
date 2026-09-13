import "fake-indexeddb/auto";

import assert from "node:assert/strict";

import { contentHash } from "../src/core/content-hash";
import { ClientStore, type PendingCreate } from "../src/storage/client-store";
import { type LocalVault, RemoteApply } from "../src/sync/remote-apply";
import type {
    ContentTransport,
    RemoteChange,
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
