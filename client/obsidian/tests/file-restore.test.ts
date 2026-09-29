import "fake-indexeddb/auto";

import assert from "node:assert/strict";

import { contentHash } from "../src/core/content-hash";
import { ClientStore } from "../src/storage/client-store";
import { CreateSync } from "../src/sync/create-sync";
import { FileRestore } from "../src/sync/file-restore";
import type { LocalVault } from "../src/sync/remote-apply";
import type {
    HistoryContentResult,
    HistoryTransport,
    ReadResult,
    RemoteHistoryEntry,
    RemoteHistoryPage,
    SyncTransport,
} from "../src/transport/server-client";

const SERVER_URL = "https://vaultdatum.test";

async function restoresAPresentFileAsAModifyAgainstTheReplica(): Promise<void> {
    const fixture = await restoreFixture();
    const current = bytes("Current version");
    const earlier = bytes("Earlier version");
    await fixture.vault.writeFile("notes/a.md", current);
    await fixture.store.putReplica({
        path: "notes/a.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 5,
        contentHash: await contentHash(current),
        size: current.byteLength,
    });
    fixture.transport.kept.set(await contentHash(earlier), earlier);

    const outcome = await fixture.restore.restore(
        "notes/a.md",
        await presentEntry(3, earlier),
    );

    assert.deepEqual(outcome, { kind: "QUEUED" });
    assert.equal(
        await fixture.vault.hash("notes/a.md"),
        await contentHash(earlier),
    );
    const [pending] = await fixture.store.pendingOperations();
    assert.equal(pending?.type, "MODIFY");
    assert.ok(pending?.type === "MODIFY");
    assert.equal(pending.baseRevision, 5);
    assert.equal(pending.baseContentHash, await contentHash(current));
    assert.equal(pending.contentHash, await contentHash(earlier));
}

async function restoresADeletedFileAsAnExplicitCreate(): Promise<void> {
    const fixture = await restoreFixture();
    const earlier = bytes("Deleted content");
    await fixture.store.putReplica({
        path: "notes/deleted.md",
        entryType: "FILE",
        state: "DELETED",
        revision: 7,
    });
    fixture.transport.kept.set(await contentHash(earlier), earlier);

    const outcome = await fixture.restore.restore(
        "notes/deleted.md",
        await presentEntry(6, earlier),
    );

    assert.deepEqual(outcome, { kind: "QUEUED" });
    assert.equal(
        await fixture.vault.hash("notes/deleted.md"),
        await contentHash(earlier),
    );
    const [pending] = await fixture.store.pendingOperations();
    assert.ok(pending?.type === "CREATE");
    assert.deepEqual(pending.base, { state: "DELETED", revision: 7 });
    assert.equal(pending.contentHash, await contentHash(earlier));
}

async function blocksRestoresThatWouldHideLocalWork(): Promise<void> {
    const fixture = await restoreFixture();
    const synced = bytes("Synced");
    const edited = bytes("Edited locally");
    const earlier = bytes("Earlier");
    await fixture.vault.writeFile("notes/out-of-sync.md", edited);
    await fixture.store.putReplica({
        path: "notes/out-of-sync.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 2,
        contentHash: await contentHash(synced),
        size: synced.byteLength,
    });
    await fixture.vault.writeFile("notes/occupied.md", edited);
    await fixture.store.putReplica({
        path: "notes/occupied.md",
        entryType: "FILE",
        state: "DELETED",
        revision: 4,
    });
    await fixture.vault.writeFile("notes/current.md", synced);
    await fixture.store.putReplica({
        path: "notes/current.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 3,
        contentHash: await contentHash(synced),
        size: synced.byteLength,
    });

    assert.deepEqual(
        await fixture.restore.restore(
            "notes/out-of-sync.md",
            await presentEntry(1, earlier),
        ),
        { kind: "BLOCKED", reason: "OUT_OF_SYNC" },
    );
    assert.deepEqual(
        await fixture.restore.restore(
            "notes/occupied.md",
            await presentEntry(1, earlier),
        ),
        { kind: "BLOCKED", reason: "PATH_OCCUPIED" },
    );
    assert.deepEqual(
        await fixture.restore.restore(
            "notes/current.md",
            await presentEntry(3, synced),
        ),
        { kind: "BLOCKED", reason: "ALREADY_CURRENT" },
    );
    assert.equal(
        await fixture.vault.hash("notes/out-of-sync.md"),
        await contentHash(edited),
    );
    assert.deepEqual(await fixture.store.pendingOperations(), []);
}

async function reportsContentThatIsNoLongerKept(): Promise<void> {
    const fixture = await restoreFixture();
    const current = bytes("Current");
    await fixture.vault.writeFile("notes/gone.md", current);
    await fixture.store.putReplica({
        path: "notes/gone.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 9,
        contentHash: await contentHash(current),
        size: current.byteLength,
    });

    const outcome = await fixture.restore.restore(
        "notes/gone.md",
        await presentEntry(2, bytes("Collected")),
    );

    assert.deepEqual(outcome, { kind: "NOT_RETAINED" });
    assert.equal(
        await fixture.vault.hash("notes/gone.md"),
        await contentHash(current),
    );
    assert.deepEqual(await fixture.store.pendingOperations(), []);
}

async function rejectsContentThatDoesNotMatchItsEntry(): Promise<void> {
    const fixture = await restoreFixture();
    const current = bytes("Current");
    const expected = bytes("Expected");
    await fixture.vault.writeFile("notes/tampered.md", current);
    await fixture.store.putReplica({
        path: "notes/tampered.md",
        entryType: "FILE",
        state: "PRESENT",
        revision: 4,
        contentHash: await contentHash(current),
        size: current.byteLength,
    });
    fixture.transport.kept.set(await contentHash(expected), bytes("Tampered"));

    await assert.rejects(
        fixture.restore.restore(
            "notes/tampered.md",
            await presentEntry(2, expected),
        ),
    );
    assert.equal(
        await fixture.vault.hash("notes/tampered.md"),
        await contentHash(current),
    );
}

async function restoreFixture(): Promise<{
    readonly store: ClientStore;
    readonly vault: MemoryVault;
    readonly transport: MemoryHistoryTransport;
    readonly restore: FileRestore;
}> {
    const store = await ClientStore.open(
        `test-file-restore-${crypto.randomUUID()}`,
    );
    const vault = new MemoryVault();
    const transport = new MemoryHistoryTransport();
    const createSync = new CreateSync(
        store,
        unusedSyncTransport(),
        vault,
        () => SERVER_URL,
    );
    const restore = new FileRestore(
        store,
        transport,
        vault,
        () => SERVER_URL,
        (path, content) => createSync.captureModify(path, content),
    );
    return { store, vault, transport, restore };
}

async function presentEntry(
    revision: number,
    content: ArrayBuffer,
): Promise<RemoteHistoryEntry> {
    return {
        revision,
        type: "MODIFY",
        committedAt: "2026-09-28T09:10:00Z",
        actor: { type: "CLIENT", clientId: "other-device" },
        state: "PRESENT",
        contentHash: await contentHash(content),
        size: content.byteLength,
        contentAvailable: true,
    };
}

class MemoryHistoryTransport implements HistoryTransport {
    public readonly kept = new Map<string, ArrayBuffer>();

    public async listFileHistory(): Promise<ReadResult<RemoteHistoryPage>> {
        return { kind: "UNAVAILABLE" };
    }

    public async downloadHistoryContent(
        _serverUrl: string,
        hash: string,
    ): Promise<HistoryContentResult> {
        const content = this.kept.get(hash);
        return content === undefined
            ? { kind: "CONTENT_NOT_RETAINED" }
            : { kind: "OK", value: content.slice(0) };
    }
}

function unusedSyncTransport(): SyncTransport {
    return new Proxy({} as SyncTransport, {
        get(): never {
            throw new Error("File restore must not use the sync transport");
        },
    });
}

function bytes(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
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

await restoresAPresentFileAsAModifyAgainstTheReplica();
await restoresADeletedFileAsAnExplicitCreate();
await blocksRestoresThatWouldHideLocalWork();
await reportsContentThatIsNoLongerKept();
await rejectsContentThatDoesNotMatchItsEntry();
