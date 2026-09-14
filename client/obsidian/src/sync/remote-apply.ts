import { contentHash } from "../core/content-hash";
import { exceedsSyncContentLimit } from "../core/content-limits";
import { isSyncPath } from "../core/sync-path";
import {
    type ApplyIntent,
    ClientStore,
    type KeepBothResolution,
    type ManualMergeResolution,
    type PendingCreate,
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
    type RemoteManifestEntry,
} from "../transport/server-client";

export interface LocalVaultFile {
    readonly path: string;
    readonly size: number;
}

export interface LocalVault {
    listFiles(): Promise<readonly LocalVaultFile[]>;
    fileSize(path: string): Promise<number | undefined>;
    readFile(path: string): Promise<ArrayBuffer | undefined>;
    writeFile(path: string, content: ArrayBuffer): Promise<void>;
    removeFile(path: string): Promise<void>;
}

export interface RemoteIntegration {
    readonly conflicted: number;
}

export interface ManualMergeVersions {
    readonly server: ArrayBuffer;
    readonly local: ArrayBuffer;
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
                await this.resumeOrDiscardPreparedApply(intent);
                continue;
            }

            await this.recordConflict(
                intent.path,
                intent.after,
                "REMOTE_APPLY_RECOVERY_REQUIRED",
            );
            await this.store.discardApply(intent);
        }
    }

    public async integrateChange(
        serverUrl: string,
        change: RemoteChange,
    ): Promise<RemoteIntegration> {
        const submitted = await this.store.operation(change.operationId);

        if (submitted?.type === "RENAME" && isOwnChange(change, submitted)) {
            return this.integrateOwnRename(change, submitted);
        }
        if (change.type === "RENAME" || change.type === "MOVE") {
            return this.integrateRemoteRename(serverUrl, change);
        }

        let conflicted = 0;

        for (const effect of change.effects) {
            if (await this.integrateEffect(serverUrl, change, effect)) {
                conflicted += 1;
            }
        }

        return { conflicted };
    }

    public async integrateManifestEntry(
        serverUrl: string,
        entry: RemoteManifestEntry,
    ): Promise<RemoteIntegration> {
        const effect: RemoteChangeEffect = {
            path: entry.path,
            entryType: entry.entryType,
            state: entry.state,
            contentHash: entry.contentHash,
            size: entry.size,
        };
        if (!isSyncPath(effect.path)) {
            throw new Error("Server returned an invalid sync path");
        }

        const after = replicaEntry(entry.revision, effect);
        if (remoteContentExceedsLimit(after)) {
            await this.recordConflict(
                effect.path,
                after,
                "REMOTE_CONTENT_TOO_LARGE",
                undefined,
                `manifest:${entry.revision}:${entry.path}`,
            );
            return { conflicted: 1 };
        }
        if (await this.store.hasConflict(effect.path)) {
            await this.store.putReplica(after);
            return { conflicted: 0 };
        }

        const pending = await this.store.pendingForPath(effect.path);
        if (pending !== undefined) {
            await this.recordConflict(
                effect.path,
                after,
                "SERVER_MANIFEST_OVERLAPS_PENDING",
                pending,
                `manifest:${entry.revision}:${entry.path}`,
            );
            return { conflicted: 1 };
        }

        if (await this.localContentExceedsLimit(effect.path)) {
            await this.recordConflict(
                effect.path,
                after,
                "LOCAL_CONTENT_TOO_LARGE",
                undefined,
                `manifest:${entry.revision}:${entry.path}`,
            );
            return { conflicted: 1 };
        }

        const actual = await this.localHash(effect.path);
        if (matches(after, actual)) {
            await this.store.putReplica(after);
            return { conflicted: 0 };
        }

        const existingReplica = await this.store.replica(effect.path);
        if (!matches(existingReplica, actual)) {
            await this.recordConflict(
                effect.path,
                after,
                "LOCAL_STATE_DIVERGED",
                undefined,
                `manifest:${entry.revision}:${entry.path}`,
            );
            return { conflicted: 1 };
        }

        return {
            conflicted: (await this.apply(
                serverUrl,
                effect.path,
                existingReplica,
                after,
                actual,
            ))
                ? 1
                : 0,
        };
    }

    public async recordLocalDivergence(
        path: string,
        serverState: ReplicaEntry,
    ): Promise<boolean> {
        if (await this.store.hasConflict(path)) {
            return false;
        }

        await this.recordConflict(path, serverState, "LOCAL_STATE_DIVERGED");
        return true;
    }

    public async recordLocalContentTooLarge(
        path: string,
        serverState: ReplicaEntry,
    ): Promise<boolean> {
        if (await this.store.hasConflict(path)) {
            return false;
        }

        await this.recordConflict(path, serverState, "LOCAL_CONTENT_TOO_LARGE");
        return true;
    }

    private async integrateOwnRename(
        change: RemoteChange,
        pending: PendingOperation,
    ): Promise<RemoteIntegration> {
        let conflicted = 0;

        for (const effect of change.effects) {
            if (!isSyncPath(effect.path)) {
                throw new Error("Server returned an invalid sync path");
            }
            const after = replicaEntry(change.revision, effect);
            if (await this.localContentExceedsLimit(effect.path)) {
                await this.recordConflict(
                    effect.path,
                    after,
                    "LOCAL_CONTENT_TOO_LARGE",
                    pending,
                    change.operationId,
                );
                conflicted += 1;
                continue;
            }
            const actual = await this.localHash(effect.path);
            if (!matches(after, actual)) {
                await this.recordConflict(
                    effect.path,
                    after,
                    "LOCAL_STATE_DIVERGED_AFTER_COMMIT",
                    pending,
                    change.operationId,
                );
                conflicted += 1;
                continue;
            }
            await this.store.putReplica(after);
        }

        if (conflicted === 0) {
            await this.store.completeObservedOperation(change.operationId);
        }
        return { conflicted };
    }

    private async integrateRemoteRename(
        serverUrl: string,
        change: RemoteChange,
    ): Promise<RemoteIntegration> {
        let unsafe = false;
        const effects: Array<{
            readonly effect: RemoteChangeEffect;
            readonly after: ReplicaEntry;
            readonly pending: PendingOperation | undefined;
        }> = [];

        for (const effect of change.effects) {
            if (!isSyncPath(effect.path)) {
                throw new Error("Server returned an invalid sync path");
            }
            const after = replicaEntry(change.revision, effect);
            const pending = await this.store.pendingForPath(effect.path);
            if (
                (await this.store.hasConflict(effect.path)) ||
                pending !== undefined ||
                (await this.localContentExceedsLimit(effect.path)) ||
                !matches(
                    await this.store.replica(effect.path),
                    await this.localHash(effect.path),
                )
            ) {
                unsafe = true;
            }
            effects.push({ effect, after, pending });
        }

        if (unsafe) {
            for (const { after, pending } of effects) {
                if (await this.store.hasConflict(after.path)) {
                    await this.store.putReplica(after);
                    continue;
                }
                await this.recordConflict(
                    after.path,
                    after,
                    "REMOTE_RENAME_OVERLAPS_LOCAL_STATE",
                    pending,
                    change.operationId,
                );
            }
            return { conflicted: effects.length };
        }

        let conflicted = 0;
        for (const { effect } of effects) {
            if (await this.integrateEffect(serverUrl, change, effect)) {
                conflicted += 1;
            }
        }
        return { conflicted };
    }

    public async resolveUseServer(
        serverUrl: string,
        path: string,
        keepBothResolution?: KeepBothResolution,
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

        if (keepBothResolution === undefined) {
            await this.store.discardPendingAndClearConflicts(path);
        } else {
            await this.store.completeKeepBothResolution(keepBothResolution);
        }
        return true;
    }

    public async resolveKeepBoth(
        serverUrl: string,
        path: string,
        destinationPath: string,
    ): Promise<boolean> {
        if ((await this.store.conflict(path)) === undefined) {
            return false;
        }
        if (!isSyncPath(destinationPath) || destinationPath === path) {
            throw new Error("The local copy needs a different valid sync path");
        }
        if ((await this.localVault.fileSize(destinationPath)) !== undefined) {
            throw new Error("The local copy path already exists");
        }
        if (
            (await this.store.replica(destinationPath)) !== undefined ||
            (await this.store.pendingForPath(destinationPath)) !== undefined ||
            (await this.store.hasConflict(destinationPath))
        ) {
            throw new Error(
                "The local copy path is already known to synchronization",
            );
        }

        const serverState = await this.store.replica(path);
        if (
            serverState?.entryType !== "FILE" ||
            serverState.state !== "PRESENT"
        ) {
            throw new Error(
                "Keeping both files requires a present Server file",
            );
        }

        await this.requireLocalContentWithinLimit(path);
        const localContent = await this.localVault.readFile(path);
        if (localContent === undefined) {
            throw new Error("Keeping both files requires a local file");
        }

        const pending: PendingCreate = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "CREATE",
            path: destinationPath,
            base: { state: "UNKNOWN" },
            contentHash: await contentHash(localContent),
            size: localContent.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        const resolution: KeepBothResolution = {
            resolutionId: `keep-both-${crypto.randomUUID()}`,
            sourcePath: path,
            pending,
            phase: "COPYING",
        };
        await this.store.beginKeepBothResolution(
            resolution,
            new Blob([localContent]),
        );
        return this.continueKeepBothResolution(serverUrl, resolution);
    }

    public async recoverKeepBothResolutions(serverUrl: string): Promise<void> {
        for (const resolution of await this.store.keepBothResolutions()) {
            try {
                await this.continueKeepBothResolution(serverUrl, resolution);
            } catch (error: unknown) {
                console.warn(
                    "VaultDatum could not resume a keep-both resolution",
                    error,
                );
            }
        }
    }

    public async manualMergeVersions(
        serverUrl: string,
        path: string,
    ): Promise<ManualMergeVersions> {
        if ((await this.store.conflict(path)) === undefined) {
            throw new Error("The conflict no longer exists");
        }
        const serverState = await this.presentServerFile(path);
        if (exceedsSyncContentLimit(serverState.size)) {
            throw new Error("Server content exceeds the attachment size limit");
        }
        await this.requireLocalContentWithinLimit(path);
        const local = await this.localVault.readFile(path);
        if (local === undefined) {
            throw new Error("Manual merging requires a local file");
        }
        const downloaded = await this.serverClient.downloadContent(
            serverUrl,
            path,
            serverState.revision,
            serverState.contentHash,
        );
        if (downloaded.kind !== "OK") {
            throw new Error("Could not download the current Server file");
        }
        if (
            downloaded.value.byteLength !== serverState.size ||
            (await contentHash(downloaded.value)) !== serverState.contentHash
        ) {
            throw new Error("Downloaded Server content is invalid");
        }
        return { server: downloaded.value, local };
    }

    public async resolveManualMerge(
        path: string,
        mergedContent: ArrayBuffer,
    ): Promise<boolean> {
        if ((await this.store.conflict(path)) === undefined) {
            return false;
        }
        if (exceedsSyncContentLimit(mergedContent.byteLength)) {
            throw new Error("Merged content exceeds the attachment size limit");
        }
        const serverState = await this.presentServerFile(path);
        await this.requireLocalContentWithinLimit(path);
        const local = await this.localVault.readFile(path);
        if (local === undefined) {
            throw new Error("Manual merging requires a local file");
        }

        const pending: PendingModify = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "MODIFY",
            path,
            baseRevision: serverState.revision,
            baseContentHash: serverState.contentHash,
            contentHash: await contentHash(mergedContent),
            size: mergedContent.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        const resolution: ManualMergeResolution = {
            resolutionId: `manual-merge-${crypto.randomUUID()}`,
            path,
            sourceContentHash: await contentHash(local),
            pending,
        };
        await this.store.beginManualMergeResolution(
            resolution,
            new Blob([mergedContent]),
        );
        await this.continueManualMergeResolution(resolution);
        return true;
    }

    public async recoverManualMergeResolutions(): Promise<void> {
        for (const resolution of await this.store.manualMergeResolutions()) {
            try {
                await this.continueManualMergeResolution(resolution);
            } catch (error: unknown) {
                console.warn(
                    "VaultDatum could not resume a manual merge",
                    error,
                );
            }
        }
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

        await this.requireLocalContentWithinLimit(path);
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
        if ((await this.localVault.fileSize(path)) !== undefined) {
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

    public async resolveRestoreLocal(path: string): Promise<boolean> {
        if ((await this.store.conflict(path)) === undefined) {
            return false;
        }

        const serverState = await this.store.replica(path);
        if (serverState?.state !== "DELETED") {
            throw new Error(
                "Restoring local content requires a deleted Server path",
            );
        }

        await this.requireLocalContentWithinLimit(path);
        const localContent = await this.localVault.readFile(path);
        if (localContent === undefined) {
            throw new Error("Restoring local content requires a local file");
        }

        const pending: PendingCreate = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "CREATE",
            path,
            base: { state: "DELETED", revision: serverState.revision },
            contentHash: await contentHash(localContent),
            size: localContent.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.replaceConflictWithCreate(
            pending,
            new Blob([localContent]),
        );
        return true;
    }

    private async continueKeepBothResolution(
        serverUrl: string,
        resolution: KeepBothResolution,
    ): Promise<boolean> {
        if (exceedsSyncContentLimit(resolution.pending.size)) {
            throw new Error("The local copy exceeds the attachment size limit");
        }
        const artifact = await this.store.artifact(
            resolution.pending.artifactId,
        );
        if (artifact === undefined) {
            throw new Error("The local copy content is no longer available");
        }

        const copyContent = await artifact.arrayBuffer();
        if (
            copyContent.byteLength !== resolution.pending.size ||
            (await contentHash(copyContent)) !== resolution.pending.contentHash
        ) {
            throw new Error("The durable local copy content is invalid");
        }

        const destinationContent = await this.localVault.readFile(
            resolution.pending.path,
        );
        if (destinationContent === undefined) {
            await this.localVault.writeFile(
                resolution.pending.path,
                copyContent,
            );
        } else if (
            (await contentHash(destinationContent)) !==
            resolution.pending.contentHash
        ) {
            throw new Error(
                "The local copy path changed before it was synchronized",
            );
        }

        const ready = await this.store.markKeepBothCopyReady(resolution);
        if ((await this.store.conflict(ready.sourcePath)) === undefined) {
            if (
                matches(
                    await this.store.replica(ready.sourcePath),
                    await this.localHash(ready.sourcePath),
                )
            ) {
                await this.store.completeKeepBothResolution(ready);
                return true;
            }
            return false;
        }

        return this.resolveUseServer(serverUrl, ready.sourcePath, ready);
    }

    private async continueManualMergeResolution(
        resolution: ManualMergeResolution,
    ): Promise<void> {
        if (exceedsSyncContentLimit(resolution.pending.size)) {
            throw new Error(
                "The manual merge exceeds the attachment size limit",
            );
        }
        const artifact = await this.store.artifact(
            resolution.pending.artifactId,
        );
        if (artifact === undefined) {
            throw new Error("The manual merge content is no longer available");
        }
        const mergedContent = await artifact.arrayBuffer();
        if (
            mergedContent.byteLength !== resolution.pending.size ||
            (await contentHash(mergedContent)) !==
                resolution.pending.contentHash
        ) {
            throw new Error("The durable manual merge content is invalid");
        }

        await this.requireLocalContentWithinLimit(resolution.path);
        const localContent = await this.localVault.readFile(resolution.path);
        const localHash =
            localContent === undefined
                ? undefined
                : await contentHash(localContent);
        if (localHash === resolution.pending.contentHash) {
            await this.store.completeManualMergeResolution(resolution);
            return;
        }
        if (localHash !== resolution.sourceContentHash) {
            throw new Error(
                "The local file changed before the manual merge applied",
            );
        }

        await this.localVault.writeFile(resolution.path, mergedContent);
        await this.store.completeManualMergeResolution(resolution);
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

        if (remoteContentExceedsLimit(after)) {
            await this.recordConflict(
                effect.path,
                after,
                "REMOTE_CONTENT_TOO_LARGE",
                undefined,
                change.operationId,
            );
            return true;
        }

        if (await this.store.hasConflict(effect.path)) {
            await this.store.putReplica(after);
            return false;
        }

        if (await this.localContentExceedsLimit(effect.path)) {
            await this.recordConflict(
                effect.path,
                after,
                "LOCAL_CONTENT_TOO_LARGE",
                undefined,
                change.operationId,
            );
            return true;
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
            phase: "PREPARED",
            artifactId:
                after.state === "PRESENT"
                    ? `apply-${after.revision}:${path}`
                    : undefined,
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
        if (exceedsSyncContentLimit(after.size)) {
            await this.store.discardApply(intent);
            await this.recordConflict(path, after, "REMOTE_CONTENT_TOO_LARGE");
            return true;
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

        const staged = await this.store.stageApplyContent(
            intent,
            new Blob([downloaded.value]),
        );
        await this.localVault.writeFile(path, downloaded.value);
        await this.store.completeApply(staged);
        return false;
    }

    private async resumeOrDiscardPreparedApply(
        intent: ApplyIntent,
    ): Promise<void> {
        const stagedContent = await this.store.applyContent(intent);
        if (
            stagedContent === undefined ||
            intent.after.state !== "PRESENT" ||
            intent.after.contentHash === undefined ||
            intent.after.size === undefined ||
            exceedsSyncContentLimit(intent.after.size)
        ) {
            await this.store.discardApply(intent);
            return;
        }

        const content = await stagedContent.arrayBuffer();
        if (
            content.byteLength !== intent.after.size ||
            (await contentHash(content)) !== intent.after.contentHash
        ) {
            await this.store.discardApply(intent);
            return;
        }

        await this.localVault.writeFile(intent.path, content);
        await this.store.completeApply(intent);
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

    private async localContentExceedsLimit(path: string): Promise<boolean> {
        const size = await this.localVault.fileSize(path);
        return size !== undefined && exceedsSyncContentLimit(size);
    }

    private async requireLocalContentWithinLimit(path: string): Promise<void> {
        if (await this.localContentExceedsLimit(path)) {
            throw new Error("Local content exceeds the attachment size limit");
        }
    }

    private async presentServerFile(path: string): Promise<
        ReplicaEntry & {
            readonly entryType: "FILE";
            readonly state: "PRESENT";
            readonly contentHash: string;
            readonly size: number;
        }
    > {
        const serverState = await this.store.replica(path);
        if (
            serverState === undefined ||
            serverState.entryType !== "FILE" ||
            serverState.state !== "PRESENT" ||
            serverState.contentHash === undefined ||
            serverState.size === undefined
        ) {
            throw new Error("Manual merging requires a present Server file");
        }
        return {
            ...serverState,
            entryType: "FILE",
            state: "PRESENT",
            contentHash: serverState.contentHash,
            size: serverState.size,
        };
    }
}

function remoteContentExceedsLimit(entry: ReplicaEntry): boolean {
    return (
        entry.state === "PRESENT" &&
        entry.size !== undefined &&
        exceedsSyncContentLimit(entry.size)
    );
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
