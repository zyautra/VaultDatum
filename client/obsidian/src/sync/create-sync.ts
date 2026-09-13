import { contentHash } from "../core/content-hash";
import { isSyncPath } from "../core/sync-path";
import {
    ClientStore,
    type PendingCreate,
    VaultMismatchError,
} from "../storage/client-store";
import { RemoteApply, type LocalVault } from "./remote-apply";
import type { SyncTransport } from "../transport/server-client";

export interface SyncSummary {
    readonly committed: number;
    readonly conflicted: number;
    readonly offline: boolean;
    readonly vaultMismatch: boolean;
}

interface PullSummary {
    readonly conflicted: number;
    readonly unavailable: boolean;
}

export class CreateSync {
    private activeSync: Promise<SyncSummary> | undefined;

    private readonly remoteApply: RemoteApply;

    public constructor(
        private readonly store: ClientStore,
        private readonly serverClient: SyncTransport,
        private readonly localVault: LocalVault,
        private readonly serverUrl: () => string,
    ) {
        this.remoteApply = new RemoteApply(store, serverClient, localVault);
    }

    public async captureCreate(
        path: string,
        content: ArrayBuffer,
    ): Promise<PendingCreate | undefined> {
        if (!isSyncPath(path)) {
            return undefined;
        }

        const hash = await contentHash(content);
        if (await this.store.hasPreparedRemoteApply(path, hash)) {
            return undefined;
        }
        if (await this.store.hasConflict(path)) {
            return undefined;
        }

        const replica = await this.store.replica(path);
        if (replica?.state === "PRESENT" && replica.contentHash === hash) {
            return undefined;
        }

        const existing = await this.store.findActiveCreate(path);
        if (existing !== undefined) {
            return existing;
        }

        const clientId = await this.store.clientId();
        const pending: PendingCreate = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId,
            type: "CREATE",
            path,
            contentHash: hash,
            size: content.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };

        await this.store.saveCreate(pending, new Blob([content]));
        return pending;
    }

    public sync(): Promise<SyncSummary> {
        if (this.activeSync === undefined) {
            this.activeSync = this.runSync().finally(() => {
                this.activeSync = undefined;
            });
        }

        return this.activeSync;
    }

    private async runSync(): Promise<SyncSummary> {
        const serverUrl = this.serverUrl();

        if (serverUrl.length === 0) {
            return unavailable(0, 0);
        }

        try {
            await this.remoteApply.recoverInterruptedApplies();

            const beforePush = await this.pull(serverUrl);
            if (beforePush.unavailable) {
                return unavailable(0, beforePush.conflicted);
            }

            const pushed = await this.push(serverUrl);
            if (pushed.offline) {
                return unavailable(
                    pushed.committed,
                    beforePush.conflicted + pushed.conflicted,
                );
            }

            const afterPush = await this.pull(serverUrl);
            if (afterPush.unavailable) {
                return unavailable(
                    pushed.committed,
                    beforePush.conflicted +
                        pushed.conflicted +
                        afterPush.conflicted,
                );
            }

            return {
                committed: pushed.committed,
                conflicted:
                    beforePush.conflicted +
                    pushed.conflicted +
                    afterPush.conflicted,
                offline: false,
                vaultMismatch: false,
            };
        } catch (error: unknown) {
            if (error instanceof VaultMismatchError) {
                return {
                    committed: 0,
                    conflicted: 0,
                    offline: false,
                    vaultMismatch: true,
                };
            }

            console.warn("VaultDatum synchronization failed", error);
            return unavailable(0, 0);
        }
    }

    private async pull(serverUrl: string): Promise<PullSummary> {
        const vault = await this.serverClient.readVault(serverUrl);

        if (vault.kind !== "OK") {
            return { conflicted: 0, unavailable: true };
        }

        let state = await this.store.confirmVault(vault.value.vaultId);
        let conflicted = 0;

        while (state.serverCursor < vault.value.currentRevision) {
            const page = await this.serverClient.listChanges(
                serverUrl,
                state.serverCursor,
                500,
            );

            if (page.kind !== "OK") {
                return { conflicted, unavailable: true };
            }
            if (page.value.vaultId !== vault.value.vaultId) {
                throw new Error(
                    "Server changed Vault identity during synchronization",
                );
            }
            if (
                page.value.changes.length === 0 ||
                page.value.toInclusive < state.serverCursor
            ) {
                throw new Error("Server returned an incomplete change page");
            }

            let expectedRevision = state.serverCursor + 1;
            for (const change of page.value.changes) {
                if (change.revision !== expectedRevision) {
                    throw new Error(
                        "Server change revisions are not contiguous",
                    );
                }

                const integrated = await this.remoteApply.integrateChange(
                    serverUrl,
                    change,
                );
                conflicted += integrated.conflicted;
                expectedRevision += 1;
            }
            if (page.value.toInclusive !== expectedRevision - 1) {
                throw new Error(
                    "Server change page cursor does not match its changes",
                );
            }

            await this.store.advanceCursor(
                vault.value.vaultId,
                page.value.toInclusive,
            );
            state = await this.store.syncState();

            if (!page.value.hasMore) {
                break;
            }
        }

        return { conflicted, unavailable: false };
    }

    private async push(serverUrl: string): Promise<{
        readonly committed: number;
        readonly conflicted: number;
        readonly offline: boolean;
    }> {
        let committed = 0;
        let conflicted = 0;
        const pendingCreates = await this.store.pendingCreates();

        for (const pending of pendingCreates) {
            const artifact = await this.store.artifact(pending.artifactId);

            if (artifact === undefined) {
                await this.store.markConflict(
                    pending.operationId,
                    "LOCAL_ARTIFACT_MISSING",
                );
                conflicted += 1;
                continue;
            }

            await this.store.markInFlight(pending.operationId);

            let result;
            try {
                result = await this.serverClient.submitCreate(
                    serverUrl,
                    pending,
                    artifact,
                );
            } catch {
                return { committed, conflicted, offline: true };
            }

            if (result.kind === "COMMITTED") {
                await this.store.markCommitted(pending.operationId);
                committed += 1;
                continue;
            }
            if (result.kind === "REJECTED") {
                await this.store.markConflict(pending.operationId, result.code);
                conflicted += 1;
                continue;
            }

            return { committed, conflicted, offline: true };
        }

        return { committed, conflicted, offline: false };
    }
}

function unavailable(committed: number, conflicted: number): SyncSummary {
    return {
        committed,
        conflicted,
        offline: true,
        vaultMismatch: false,
    };
}
