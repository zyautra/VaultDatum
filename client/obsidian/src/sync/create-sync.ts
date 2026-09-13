import { contentHash } from "../core/content-hash";
import { isSyncPath } from "../core/sync-path";
import {
    ClientStore,
    type PendingCreate,
    type PendingDelete,
    type PendingModify,
    type PendingOperation,
    type ReplicaEntry,
    VaultMismatchError,
} from "../storage/client-store";
import {
    type RemoteChange,
    type RemoteChangeEffect,
    type SubmitOperationResult,
    type SyncTransport,
} from "../transport/server-client";
import { RemoteApply, type LocalVault } from "./remote-apply";

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
    ): Promise<PendingOperation | undefined> {
        return this.captureContent(path, content);
    }

    public async captureModify(
        path: string,
        content: ArrayBuffer,
    ): Promise<PendingOperation | undefined> {
        return this.captureContent(path, content);
    }

    public async captureDelete(
        path: string,
    ): Promise<PendingDelete | undefined> {
        if (
            !isSyncPath(path) ||
            (await this.store.hasPreparedRemoteDelete(path))
        ) {
            return undefined;
        }
        if (await this.store.hasConflict(path)) {
            return undefined;
        }

        const active = await this.store.findActiveOperation(path);
        if (active?.type === "CREATE" && active.status === "READY") {
            await this.store.discardPending(active.operationId);
            return undefined;
        }
        if (active?.type === "MODIFY" && active.status === "READY") {
            await this.store.discardPending(active.operationId);
        }
        if (active?.type === "DELETE") {
            return active;
        }

        const replica = await this.store.replica(path);
        if (!isPresentFile(replica)) {
            return undefined;
        }

        const clientId = await this.store.clientId();
        const pending: PendingDelete = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId,
            type: "DELETE",
            path,
            baseRevision: replica.revision,
            baseContentHash: replica.contentHash,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.saveDelete(pending);
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

    public async resolveUseServer(path: string): Promise<boolean> {
        const serverUrl = this.serverUrl();

        if (serverUrl.length === 0) {
            throw new Error(
                "A server URL is required to use the server version",
            );
        }

        return this.remoteApply.resolveUseServer(serverUrl, path);
    }

    public async resolveApplyLocal(path: string): Promise<boolean> {
        return this.remoteApply.resolveApplyLocal(path);
    }

    public async resolveKeepDeleted(path: string): Promise<boolean> {
        return this.remoteApply.resolveKeepDeleted(path);
    }

    public async resolveRestoreLocal(path: string): Promise<boolean> {
        return this.remoteApply.resolveRestoreLocal(path);
    }

    public async resolveKeepBoth(
        path: string,
        destinationPath: string,
    ): Promise<boolean> {
        const serverUrl = this.serverUrl();

        if (serverUrl.length === 0) {
            throw new Error(
                "A server URL is required to keep both file versions",
            );
        }

        return this.remoteApply.resolveKeepBoth(
            serverUrl,
            path,
            destinationPath,
        );
    }

    private async captureContent(
        path: string,
        content: ArrayBuffer,
    ): Promise<PendingOperation | undefined> {
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

        const active = await this.store.findActiveOperation(path);
        if (active !== undefined) {
            if (active.type === "DELETE") {
                return active;
            }
            const updated = {
                ...active,
                contentHash: hash,
                size: content.byteLength,
            };
            await this.store.saveContentOperation(updated, new Blob([content]));
            return updated;
        }

        const replica = await this.store.replica(path);
        if (replica?.state === "PRESENT" && replica.contentHash === hash) {
            return undefined;
        }

        const clientId = await this.store.clientId();
        if (isPresentFile(replica)) {
            const pending: PendingModify = {
                operationId: `OP-${crypto.randomUUID()}`,
                clientId,
                type: "MODIFY",
                path,
                baseRevision: replica.revision,
                baseContentHash: replica.contentHash,
                contentHash: hash,
                size: content.byteLength,
                artifactId: `artifact-${crypto.randomUUID()}`,
                createdAt: new Date().toISOString(),
                status: "READY",
            };
            await this.store.saveContentOperation(pending, new Blob([content]));
            return pending;
        }
        if (replica?.state === "DELETED") {
            return undefined;
        }

        const pending: PendingCreate = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId,
            type: "CREATE",
            path,
            base: { state: "UNKNOWN" },
            contentHash: hash,
            size: content.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.saveContentOperation(pending, new Blob([content]));
        return pending;
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

            await this.remoteApply.recoverKeepBothResolutions(serverUrl);

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

        const state = await this.store.confirmVault(vault.value.vaultId);
        if (state.serverCursor >= vault.value.currentRevision) {
            return { conflicted: 0, unavailable: false };
        }

        let cursor = state.serverCursor;
        const changes: RemoteChange[] = [];

        while (cursor < vault.value.currentRevision) {
            const page = await this.serverClient.listChanges(
                serverUrl,
                cursor,
                500,
            );

            if (page.kind !== "OK") {
                return { conflicted: 0, unavailable: true };
            }
            if (page.value.vaultId !== vault.value.vaultId) {
                throw new Error(
                    "Server changed Vault identity during synchronization",
                );
            }
            if (
                page.value.changes.length === 0 ||
                page.value.toInclusive < cursor
            ) {
                throw new Error("Server returned an incomplete change page");
            }

            let expectedRevision = cursor + 1;
            for (const change of page.value.changes) {
                if (change.revision !== expectedRevision) {
                    throw new Error(
                        "Server change revisions are not contiguous",
                    );
                }
                changes.push(change);
                expectedRevision += 1;
            }
            if (page.value.toInclusive !== expectedRevision - 1) {
                throw new Error(
                    "Server change page cursor does not match its changes",
                );
            }

            cursor = page.value.toInclusive;
            if (!page.value.hasMore) {
                break;
            }
        }

        let conflicted = 0;
        const integratedOwnEffects = new Set<string>();
        for (const change of changes) {
            if (!(await this.isTrackedOwnChange(change))) {
                continue;
            }

            const integrated = await this.remoteApply.integrateChange(
                serverUrl,
                change,
            );
            conflicted += integrated.conflicted;
            for (const effect of change.effects) {
                integratedOwnEffects.add(effectKey(change, effect));
            }
        }
        for (const change of latestPathEffects(changes)) {
            if (
                integratedOwnEffects.has(effectKey(change, change.effects[0]))
            ) {
                continue;
            }
            const integrated = await this.remoteApply.integrateChange(
                serverUrl,
                change,
            );
            conflicted += integrated.conflicted;
        }
        await this.store.advanceCursor(vault.value.vaultId, cursor);
        return { conflicted, unavailable: false };
    }

    private async push(serverUrl: string): Promise<{
        readonly committed: number;
        readonly conflicted: number;
        readonly offline: boolean;
    }> {
        let committed = 0;
        let conflicted = 0;
        const pendingOperations = await this.store.pendingOperations();

        for (const pending of pendingOperations) {
            await this.store.markInFlight(pending.operationId);

            let result: SubmitOperationResult;
            try {
                result = await this.submit(serverUrl, pending);
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

    private async submit(
        serverUrl: string,
        pending: PendingOperation,
    ): Promise<SubmitOperationResult> {
        if (pending.type === "DELETE") {
            return this.serverClient.submitDelete(serverUrl, pending);
        }

        const artifact = await this.store.artifact(pending.artifactId);
        if (artifact === undefined) {
            await this.store.markConflict(
                pending.operationId,
                "LOCAL_ARTIFACT_MISSING",
            );
            return { kind: "REJECTED", code: "LOCAL_ARTIFACT_MISSING" };
        }

        if (pending.type === "CREATE") {
            return this.serverClient.submitCreate(serverUrl, pending, artifact);
        }
        return this.serverClient.submitModify(serverUrl, pending, artifact);
    }

    private async isTrackedOwnChange(change: RemoteChange): Promise<boolean> {
        if (change.actor.type !== "CLIENT") {
            return false;
        }

        const pending = await this.store.operation(change.operationId);
        return pending?.clientId === change.actor.clientId;
    }
}

function isPresentFile(
    entry: ReplicaEntry | undefined,
): entry is ReplicaEntry & {
    readonly entryType: "FILE";
    readonly state: "PRESENT";
    readonly contentHash: string;
    readonly size: number;
} {
    return (
        entry?.entryType === "FILE" &&
        entry.state === "PRESENT" &&
        entry.contentHash !== undefined &&
        entry.size !== undefined
    );
}

function latestPathEffects(changes: readonly RemoteChange[]): RemoteChange[] {
    const latest = new Map<string, RemoteChange>();

    for (const change of changes) {
        for (const effect of change.effects) {
            latest.set(effect.path, singleEffectChange(change, effect));
        }
    }

    return [...latest.values()].sort(
        (left, right) => left.revision - right.revision,
    );
}

function singleEffectChange(
    change: RemoteChange,
    effect: RemoteChangeEffect,
): RemoteChange {
    return { ...change, effects: [effect] };
}

function effectKey(change: RemoteChange, effect: RemoteChangeEffect): string {
    return `${change.revision}:${effect.path}`;
}

function unavailable(committed: number, conflicted: number): SyncSummary {
    return {
        committed,
        conflicted,
        offline: true,
        vaultMismatch: false,
    };
}
