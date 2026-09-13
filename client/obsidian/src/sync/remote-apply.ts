import { contentHash } from "../core/content-hash";
import { isSyncPath } from "../core/sync-path";
import {
    type ApplyIntent,
    ClientStore,
    type PendingDelete,
    type PendingModify,
    type PendingOperation,
    type ReplicaEntry,
    type RemoteConflict,
} from "../storage/client-store";
import {
    type ContentTransport,
    type RemoteChange,
    type RemoteChangeEffect,
} from "../transport/server-client";

export interface LocalVault {
    readFile(path: string): Promise<ArrayBuffer | undefined>;
    writeFile(path: string, content: ArrayBuffer): Promise<void>;
    removeFile(path: string): Promise<void>;
}

export interface RemoteIntegration {
    readonly conflicted: number;
}

export class RemoteApply {
    public constructor(
        private readonly store: ClientStore,
        private readonly serverClient: ContentTransport,
        private readonly localVault: LocalVault,
    ) {}

    public async recoverInterruptedApplies(): Promise<void> {
        const intents = await this.store.applyIntents();

        for (const intent of intents) {
            const actual = await this.localHash(intent.path);

            if (matches(intent.after, actual)) {
                await this.store.completeApply(intent);
                continue;
            }
            if (matches(intent.before, actual)) {
                await this.store.discardApply(intent.applyId);
                continue;
            }

            await this.recordConflict(
                intent.path,
                intent.after,
                "REMOTE_APPLY_RECOVERY_REQUIRED",
            );
            await this.store.discardApply(intent.applyId);
        }
    }

    public async integrateChange(
        serverUrl: string,
        change: RemoteChange,
    ): Promise<RemoteIntegration> {
        let conflicted = 0;

        for (const effect of change.effects) {
            if (await this.integrateEffect(serverUrl, change, effect)) {
                conflicted += 1;
            }
        }

        return { conflicted };
    }

    public async resolveUseServer(
        serverUrl: string,
        path: string,
    ): Promise<boolean> {
        if ((await this.store.conflict(path)) === undefined) {
            return false;
        }

        const after = await this.store.replica(path);
        if (after === undefined) {
            throw new Error("A conflict has no authoritative replica state");
        }

        const actual = await this.localHash(path);
        const applied = await this.apply(
            serverUrl,
            path,
            localState(path, actual, after.revision),
            after,
            actual,
        );
        if (applied) {
            return false;
        }

        await this.store.discardPendingAndClearConflicts(path);
        return true;
    }

    public async resolveApplyLocal(path: string): Promise<boolean> {
        if ((await this.store.conflict(path)) === undefined) {
            return false;
        }

        const serverState = await this.store.replica(path);
        if (
            serverState?.entryType !== "FILE" ||
            serverState.state !== "PRESENT" ||
            serverState.contentHash === undefined
        ) {
            throw new Error(
                "Applying local content requires a present Server file",
            );
        }

        const localContent = await this.localVault.readFile(path);
        if (localContent === undefined) {
            throw new Error("Applying local content requires a local file");
        }

        const localContentHash = await contentHash(localContent);
        if (localContentHash === serverState.contentHash) {
            await this.store.discardPendingAndClearConflicts(path);
            return true;
        }

        const pending: PendingModify = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "MODIFY",
            path,
            baseRevision: serverState.revision,
            baseContentHash: serverState.contentHash,
            contentHash: localContentHash,
            size: localContent.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.replaceConflictWithModify(
            pending,
            new Blob([localContent]),
        );
        return true;
    }

    public async resolveKeepDeleted(path: string): Promise<boolean> {
        if ((await this.store.conflict(path)) === undefined) {
            return false;
        }
        if ((await this.localVault.readFile(path)) !== undefined) {
            throw new Error(
                "Keeping a deletion requires the local file to be absent",
            );
        }

        const serverState = await this.store.replica(path);
        if (serverState === undefined) {
            throw new Error("A conflict has no authoritative replica state");
        }
        if (serverState.state === "DELETED") {
            await this.store.discardPendingAndClearConflicts(path);
            return true;
        }
        if (
            serverState.entryType !== "FILE" ||
            serverState.contentHash === undefined
        ) {
            throw new Error(
                "Keeping a deletion requires a present Server file",
            );
        }

        const pending: PendingDelete = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "DELETE",
            path,
            baseRevision: serverState.revision,
            baseContentHash: serverState.contentHash,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.replaceConflictWithDelete(pending);
        return true;
    }

    private async integrateEffect(
        serverUrl: string,
        change: RemoteChange,
        effect: RemoteChangeEffect,
    ): Promise<boolean> {
        if (!isSyncPath(effect.path)) {
            throw new Error("Server returned an invalid sync path");
        }

        const after = replicaEntry(change.revision, effect);
        const existingReplica = await this.store.replica(effect.path);

        if (await this.store.hasConflict(effect.path)) {
            await this.store.putReplica(after);
            return false;
        }

        const submitted = await this.store.operation(change.operationId);
        const actual = await this.localHash(effect.path);

        if (submitted !== undefined && isOwnChange(change, submitted)) {
            if (matches(after, actual)) {
                await this.store.putReplica(after);
                await this.store.completeObservedOperation(change.operationId);
                return false;
            }

            await this.recordConflict(
                effect.path,
                after,
                "LOCAL_STATE_DIVERGED_AFTER_COMMIT",
                submitted,
                change.operationId,
            );
            return true;
        }

        const pending = await this.store.pendingForPath(effect.path);
        if (pending !== undefined) {
            await this.recordConflict(
                effect.path,
                after,
                "REMOTE_CHANGE_OVERLAPS_PENDING",
                pending,
                change.operationId,
            );
            return true;
        }

        if (!matches(existingReplica, actual)) {
            await this.recordConflict(
                effect.path,
                after,
                "LOCAL_STATE_DIVERGED",
                undefined,
                change.operationId,
            );
            return true;
        }

        return this.apply(
            serverUrl,
            effect.path,
            existingReplica,
            after,
            actual,
        );
    }

    private async apply(
        serverUrl: string,
        path: string,
        before: ReplicaEntry | undefined,
        after: ReplicaEntry,
        actualHash: string | undefined,
    ): Promise<boolean> {
        if (after.entryType !== "FILE") {
            await this.recordConflict(path, after, "UNSUPPORTED_REMOTE_ENTRY");
            return true;
        }
        if (matches(after, actualHash)) {
            await this.store.putReplica(after);
            return false;
        }

        const intent: ApplyIntent = {
            applyId: `${after.revision}:${path}`,
            path,
            before,
            after,
        };
        await this.store.prepareApply(intent);

        if (after.state === "DELETED") {
            await this.localVault.removeFile(path);
            await this.store.completeApply(intent);
            return false;
        }

        if (after.contentHash === undefined || after.size === undefined) {
            throw new Error("Server returned an incomplete file state");
        }

        const downloaded = await this.serverClient.downloadContent(
            serverUrl,
            path,
            after.revision,
            after.contentHash,
        );
        if (downloaded.kind !== "OK") {
            throw new Error(
                `Could not download remote content: ${downloaded.kind}`,
            );
        }
        if (
            downloaded.value.byteLength !== after.size ||
            (await contentHash(downloaded.value)) !== after.contentHash
        ) {
            throw new Error(
                "Downloaded remote content does not match its declared state",
            );
        }

        await this.localVault.writeFile(path, downloaded.value);
        await this.store.completeApply(intent);
        return false;
    }

    private async recordConflict(
        path: string,
        serverState: ReplicaEntry,
        code: string,
        pending?: PendingOperation,
        operationId?: string,
    ): Promise<void> {
        const conflict: RemoteConflict = {
            conflictId: `${serverState.revision}:${path}`,
            path,
            revision: serverState.revision,
            code,
            serverState,
            operationId,
        };
        await this.store.recordRemoteConflict(conflict, serverState, pending);
    }

    private async localHash(path: string): Promise<string | undefined> {
        const content = await this.localVault.readFile(path);
        return content === undefined ? undefined : contentHash(content);
    }
}

function replicaEntry(
    revision: number,
    effect: RemoteChangeEffect,
): ReplicaEntry {
    if (effect.state === "DELETED") {
        return {
            path: effect.path,
            entryType: effect.entryType,
            state: "DELETED",
            revision,
        };
    }
    if (effect.entryType === "FILE") {
        if (effect.contentHash === undefined || effect.size === undefined) {
            throw new Error("Server returned an incomplete file change effect");
        }
        return {
            path: effect.path,
            entryType: "FILE",
            state: "PRESENT",
            revision,
            contentHash: effect.contentHash,
            size: effect.size,
        };
    }

    return {
        path: effect.path,
        entryType: "DIRECTORY",
        state: "PRESENT",
        revision,
    };
}

function matches(
    expected: ReplicaEntry | undefined,
    actualHash: string | undefined,
): boolean {
    if (expected === undefined || expected.state === "DELETED") {
        return actualHash === undefined;
    }

    return expected.entryType === "FILE" && expected.contentHash === actualHash;
}

function localState(
    path: string,
    contentHashValue: string | undefined,
    revision: number,
): ReplicaEntry {
    if (contentHashValue === undefined) {
        return {
            path,
            entryType: "FILE",
            state: "DELETED",
            revision,
        };
    }

    return {
        path,
        entryType: "FILE",
        state: "PRESENT",
        revision,
        contentHash: contentHashValue,
    };
}

function isOwnChange(
    change: RemoteChange,
    committed: PendingOperation,
): boolean {
    return (
        change.operationId === committed.operationId &&
        change.actor.type === "CLIENT" &&
        change.actor.clientId === committed.clientId
    );
}
