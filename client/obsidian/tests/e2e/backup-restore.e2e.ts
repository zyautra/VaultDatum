/**
 * End-to-end check of server Backup and restore with a real server and two
 * devices running the real synchronization core.
 *
 * Run with SERVER_BINARY pointing to a server runner, for example:
 *   SERVER_BINARY=../../server/build/server-0.7.0-runner npm run test:e2e
 * It waits about a minute for the first scheduled Backup.
 */
import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClientStore } from "../../src/storage/client-store";
import { CreateSync, type SyncSummary } from "../../src/sync/create-sync";
import type { LocalVault } from "../../src/sync/remote-apply";
import { ServerClient } from "../../src/transport/server-client";

const SERVER_BINARY = process.env.SERVER_BINARY ?? "";
const PORT = 18090;
const URL = `http://127.0.0.1:${PORT}`;
const DATA_ROOT = mkdtempSync(
    join(process.env.SCRATCH ?? tmpdir(), "e2e-root-"),
);

class MemoryVault implements LocalVault {
    private readonly files = new Map<string, ArrayBuffer>();
    private readonly directories = new Set<string>();
    async listFiles() {
        return [...this.files.entries()]
            .map(([path, content]) => ({ path, size: content.byteLength }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }
    async listDirectories() {
        return [...this.directories].sort();
    }
    async fileSize(path: string) {
        return this.files.get(path)?.byteLength;
    }
    async readFile(path: string) {
        return this.files.get(path)?.slice(0);
    }
    async writeFile(path: string, content: ArrayBuffer) {
        this.parents(path);
        this.files.set(path, content.slice(0));
    }
    async removeFile(path: string) {
        this.files.delete(path);
    }
    async directoryExists(path: string) {
        return this.directories.has(path);
    }
    async directoryIsEmpty(path: string) {
        if (!this.directories.has(path)) return false;
        const prefix = `${path}/`;
        return ![...this.files.keys(), ...this.directories].some((c) =>
            c.startsWith(prefix),
        );
    }
    async createDirectory(path: string) {
        this.parents(path);
        this.directories.add(path);
    }
    async removeDirectory(path: string) {
        this.directories.delete(path);
    }
    text(path: string): string | undefined {
        const content = this.files.get(path);
        return content === undefined
            ? undefined
            : new TextDecoder().decode(content);
    }
    paths(): string[] {
        return [...this.files.keys()].sort();
    }
    private parents(path: string) {
        const segments = path.split("/");
        for (let i = 1; i < segments.length; i++) {
            this.directories.add(segments.slice(0, i).join("/"));
        }
    }
}

class Device {
    readonly vault = new MemoryVault();
    readonly sync: CreateSync;
    private constructor(
        readonly name: string,
        readonly store: ClientStore,
    ) {
        this.sync = new CreateSync(
            store,
            new ServerClient(),
            this.vault,
            () => URL,
        );
    }
    static async open(name: string): Promise<Device> {
        return new Device(
            name,
            await ClientStore.open(`e2e-${name}-${crypto.randomUUID()}`),
        );
    }
    async write(path: string, text: string, existing: boolean) {
        const content = bytes(text);
        await this.vault.writeFile(path, content);
        await (existing
            ? this.sync.captureModify(path, content)
            : this.sync.captureCreate(path, content));
    }
    async remove(path: string) {
        await this.vault.removeFile(path);
        await this.sync.captureDelete(path);
    }
    async run(): Promise<SyncSummary> {
        const summary = await this.sync.sync();
        log(`${this.name} sync`, summary);
        return summary;
    }
}

let server: ChildProcess | undefined;
let serverLog = "";

async function startServer(env: Record<string, string> = {}): Promise<void> {
    serverLog = "";
    server = spawn(SERVER_BINARY, [], {
        env: {
            ...process.env,
            QUARKUS_HTTP_PORT: String(PORT),
            VAULTDATUM_DATA_ROOT: DATA_ROOT,
            ...env,
        },
    });
    server.stdout?.on("data", (chunk) => (serverLog += chunk));
    server.stderr?.on("data", (chunk) => (serverLog += chunk));
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            if ((await fetch(`${URL}/api/v1/vault`)).ok) return;
        } catch {
            // not listening yet
        }
        await sleep(200);
    }
    throw new Error(`Server did not start:\n${serverLog}`);
}

async function stopServer(): Promise<void> {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    const exited = new Promise((resolve) => running.once("exit", resolve));
    running.kill("SIGTERM");
    await exited;
}

async function vaultInfo(): Promise<{
    vaultId: string;
    currentRevision: number;
    previousVaultIds: string[];
}> {
    return (await fetch(`${URL}/api/v1/vault`)).json() as never;
}

function bytes(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(label: string, value?: unknown) {
    console.log(
        value === undefined
            ? `- ${label}`
            : `- ${label}: ${JSON.stringify(value)}`,
    );
}

function logLines(pattern: RegExp): string[] {
    return serverLog
        .split("\n")
        .filter((line) => pattern.test(line))
        .map((line) => line.replace(/^.*\] \([^)]*\) /, ""));
}

async function main() {
    const a = await Device.open("A");
    const b = await Device.open("B");

    console.log("## 1. Before the backup");
    await startServer({ VAULTDATUM_BACKUP_INTERVAL_HOURS: "24" });
    await a.write("notes/kept.md", "Kept in the backup", false);
    await a.write("notes/edited.md", "Before the backup", false);
    await a.write("notes/deleted-later.md", "Deleted after the backup", false);
    assert.equal((await a.run()).committed, 3);
    await b.run();
    assert.deepEqual(b.vault.paths(), [
        "notes/deleted-later.md",
        "notes/edited.md",
        "notes/kept.md",
    ]);
    const before = await vaultInfo();
    log("server", before);

    console.log("## 2. Scheduled backup (first run one minute after startup)");
    for (let i = 0; i < 90 && logLines(/backup_complete/).length === 0; i++)
        await sleep(1000);
    log("log", logLines(/backup_/));
    const backup = JSON.parse(
        readFileSync(join(DATA_ROOT, "backups/current/backup.json"), "utf8"),
    );
    assert.equal(backup.revision, before.currentRevision);

    console.log("## 3. Changes after the backup");
    await a.write(
        "notes/created-after.md",
        "Created by A after the backup",
        false,
    );
    await a.write("notes/edited.md", "Edited by A after the backup", true);
    await a.remove("notes/deleted-later.md");
    assert.equal((await a.run()).committed, 3);
    await b.run();
    await b.write("notes/from-b.md", "Created by B after the backup", false);
    assert.equal((await b.run()).committed, 1);
    await a.run();
    log("server", await vaultInfo());
    log("B files", b.vault.paths());

    console.log("## 4. Restore the backup");
    await stopServer();
    await startServer({
        VAULTDATUM_RESTORE_BACKUP: "true",
        VAULTDATUM_BACKUP_INTERVAL_HOURS: "0",
    });
    log("log", logLines(/restore_|integrity_scan|backup_/));
    await stopServer();
    await startServer({ VAULTDATUM_BACKUP_INTERVAL_HOURS: "0" });
    const restored = await vaultInfo();
    log("server", restored);
    assert.notEqual(restored.vaultId, before.vaultId);
    assert.deepEqual(restored.previousVaultIds, [before.vaultId]);
    assert.equal(restored.currentRevision, before.currentRevision);

    console.log("## 5. Devices stop and nothing is sent");
    const aStopped = await a.run();
    assert.equal(aStopped.vaultMismatch, true);
    assert.equal(aStopped.vaultRestored, true);
    assert.equal((await vaultInfo()).currentRevision, restored.currentRevision);

    console.log("## 6. Device A reconnects");
    log("A reconnect", await a.sync.reconnectToRestoredVault());
    const aSummary = await a.run();
    assert.equal(aSummary.vaultMismatch, false);
    log(
        "A conflicts",
        (await a.store.conflicts()).map((c) => c.path),
    );
    log("A files", a.vault.paths());

    console.log("## 7. Device B reconnects");
    assert.equal((await b.run()).vaultRestored, true);
    log("B reconnect", await b.sync.reconnectToRestoredVault());
    await b.run();
    await a.run();
    log(
        "B conflicts",
        (await b.store.conflicts()).map((c) => c.path),
    );
    log("B files", b.vault.paths());
    log("server", await vaultInfo());

    console.log("## 8. Checks");
    // Created after the backup on either device: back on the server and on both devices.
    for (const device of [a, b]) {
        assert.equal(
            device.vault.text("notes/created-after.md"),
            "Created by A after the backup",
        );
        assert.equal(
            device.vault.text("notes/from-b.md"),
            "Created by B after the backup",
        );
        // Edited after the backup: the local edit is kept and recorded as a conflict.
        assert.equal(
            device.vault.text("notes/edited.md"),
            "Edited by A after the backup",
        );
        assert.deepEqual(
            (await device.store.conflicts()).map((c) => c.path),
            ["notes/edited.md"],
        );
        // Deleted after the backup: comes back from the server.
        assert.equal(
            device.vault.text("notes/deleted-later.md"),
            "Deleted after the backup",
        );
        assert.equal(device.vault.text("notes/kept.md"), "Kept in the backup");
        assert.equal(
            (await device.store.syncState()).vaultId,
            restored.vaultId,
        );
    }
    assert.equal(
        (await vaultInfo()).currentRevision,
        restored.currentRevision + 2,
        "exactly the two files created after the backup were sent again",
    );
    console.log("E2E PASSED");
}

try {
    await main();
} finally {
    await stopServer();
    console.log(`data root: ${DATA_ROOT}`);
}
