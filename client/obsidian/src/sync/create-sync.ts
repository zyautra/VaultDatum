import { contentHash } from "../core/content-hash";
import { exceedsSyncContentLimit } from "../core/content-limits";
import { isSyncPath } from "../core/sync-path";
import {
    ClientStore,
    type LocalScanBaseline,
    type PendingCreate,
    type PendingDelete,
    type PendingDirectoryCreate,
    type PendingDirectoryDelete,
    type PendingDirectoryMove,
    type PendingDirectoryRename,
    type PendingMove,
    type PendingModify,
    type PendingOperation,
    type PendingRename,
    type ReplicaEntry,
    VaultMismatchError,
} from "../storage/client-store";
import {
    type RemoteChange,
    type RemoteChangeEffect,
    type RemoteManifest,
    type RemoteManifestCreated,
    type SubmitOperationResult,
    type SyncTransport,
} from "../transport/server-client";
import {
    RemoteApply,
    type LocalVault,
    type ManualMergeVersions,
} from "./remote-apply";

export interface SyncSummary {
    readonly committed: number;
    readonly conflicted: number;
    readonly oversized: number;
    readonly offline: boolean;
    readonly vaultMismatch: boolean;
}

interface PullSummary {
    readonly conflicted: number;
    readonly unavailable: boolean;
    readonly historyUnavailable: boolean;
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

    public async captureFilePathChange(
        sourcePath: string,
        destinationPath: string,
    ): Promise<PendingRename | PendingMove | undefined> {
        if (
            !isSyncPath(sourcePath) ||
            !isSyncPath(destinationPath) ||
            sourcePath === destinationPath ||
            (await this.store.hasConflict(sourcePath)) ||
            (await this.store.hasConflict(destinationPath)) ||
            (await this.store.findActiveOperation(sourcePath)) !== undefined ||
            (await this.store.findActiveOperation(destinationPath)) !==
                undefined
        ) {
            return undefined;
        }

        const source = await this.store.replica(sourcePath);
        if (!isPresentFile(source)) {
            return undefined;
        }
        if ((await this.store.replica(destinationPath)) !== undefined) {
            return undefined;
        }

        const pending =
            parentPath(sourcePath) === parentPath(destinationPath)
                ? ({
                      operationId: `OP-${crypto.randomUUID()}`,
                      clientId: await this.store.clientId(),
                      type: "RENAME",
                      path: sourcePath,
                      destinationPath,
                      baseRevision: source.revision,
                      baseContentHash: source.contentHash,
                      createdAt: new Date().toISOString(),
                      status: "READY",
                  } satisfies PendingRename)
                : ({
                      operationId: `OP-${crypto.randomUUID()}`,
                      clientId: await this.store.clientId(),
                      type: "MOVE",
                      path: sourcePath,
                      destinationPath,
                      baseRevision: source.revision,
                      baseContentHash: source.contentHash,
                      createdAt: new Date().toISOString(),
                      status: "READY",
                  } satisfies PendingMove);
        await this.store.savePathChange(pending);
        return pending;
    }

    public async captureDirectoryCreate(
        path: string,
    ): Promise<PendingDirectoryCreate | undefined> {
        if (
            !isSyncPath(path) ||
            !(await this.localVault.directoryIsEmpty(path)) ||
            (await this.store.hasPreparedRemoteDirectoryApply(path)) ||
            (await this.store.hasConflict(path)) ||
            (await this.store.findActiveOperation(path)) !== undefined ||
            (await this.store.replica(path)) !== undefined
        ) {
            return undefined;
        }
        const pending: PendingDirectoryCreate = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "DIRECTORY_CREATE",
            path,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.saveDirectoryOperation(pending);
        return pending;
    }

    public async captureDirectoryDelete(
        path: string,
    ): Promise<PendingDirectoryDelete | undefined> {
        if (
            !isSyncPath(path) ||
            (await this.store.hasPreparedRemoteDelete(path)) ||
            (await this.store.hasConflict(path)) ||
            (await this.hasPresentDescendants(path))
        ) {
            return undefined;
        }
        const active = await this.store.findActiveOperation(path);
        if (active?.type === "DIRECTORY_CREATE" && active.status === "READY") {
            await this.store.discardPending(active.operationId);
            return undefined;
        }
        if (active?.type === "DIRECTORY_DELETE") {
            return active;
        }
        if (active !== undefined) {
            return undefined;
        }
        const replica = await this.store.replica(path);
        if (replica?.entryType !== "DIRECTORY" || replica.state !== "PRESENT") {
            return undefined;
        }
        const pending: PendingDirectoryDelete = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "DIRECTORY_DELETE",
            path,
            baseRevision: replica.revision,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.saveDirectoryOperation(pending);
        return pending;
    }

    public async captureDirectoryPathChange(
        sourcePath: string,
        destinationPath: string,
    ): Promise<PendingDirectoryRename | PendingDirectoryMove | undefined> {
        if (
            !isSyncPath(sourcePath) ||
            !isSyncPath(destinationPath) ||
            sourcePath === destinationPath ||
            (await this.store.hasConflict(sourcePath)) ||
            (await this.store.hasConflict(destinationPath)) ||
            (await this.store.findActiveOperation(sourcePath)) !== undefined ||
            (await this.store.findActiveOperation(destinationPath)) !==
                undefined ||
            (await this.hasPresentDescendants(sourcePath))
        ) {
            return undefined;
        }
        const source = await this.store.replica(sourcePath);
        if (source?.entryType !== "DIRECTORY" || source.state !== "PRESENT") {
            return undefined;
        }
        if ((await this.store.replica(destinationPath)) !== undefined) {
            return undefined;
        }
        const pending =
            parentPath(sourcePath) === parentPath(destinationPath)
                ? ({
                      operationId: `OP-${crypto.randomUUID()}`,
                      clientId: await this.store.clientId(),
                      type: "DIRECTORY_RENAME",
                      path: sourcePath,
                      destinationPath,
                      baseRevision: source.revision,
                      createdAt: new Date().toISOString(),
                      status: "READY",
                  } satisfies PendingDirectoryRename)
                : ({
                      operationId: `OP-${crypto.randomUUID()}`,
                      clientId: await this.store.clientId(),
                      type: "DIRECTORY_MOVE",
                      path: sourcePath,
                      destinationPath,
                      baseRevision: source.revision,
                      createdAt: new Date().toISOString(),
                      status: "READY",
                  } satisfies PendingDirectoryMove);
        await this.store.saveDirectoryOperation(pending);
        return pending;
    }

    public sync(): Promise<SyncSummary> {
        return this.startSync(false);
    }

    public fullReconcile(): Promise<SyncSummary> {
        return this.startSync(true);
    }

    private startSync(fullReconciliation: boolean): Promise<SyncSummary> {
        if (this.activeSync === undefined) {
            this.activeSync = this.runSync(fullReconciliation).finally(() => {
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

    public async manualMergeVersions(
        path: string,
    ): Promise<ManualMergeVersions> {
        const serverUrl = this.serverUrl();

        if (serverUrl.length === 0) {
            throw new Error("A server URL is required to manually merge files");
        }

        return this.remoteApply.manualMergeVersions(serverUrl, path);
    }

    public async resolveManualMerge(
        path: string,
        mergedContent: ArrayBuffer,
    ): Promise<boolean> {
        return this.remoteApply.resolveManualMerge(path, mergedContent);
    }

    private async captureContent(
        path: string,
        content: ArrayBuffer,
    ): Promise<PendingOperation | undefined> {
        if (!isSyncPath(path) || exceedsSyncContentLimit(content.byteLength)) {
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
            if (
                active.type === "DELETE" ||
                active.type === "DIRECTORY_DELETE"
            ) {
                return active;
            }
            if (
                active.type === "RENAME" ||
                active.type === "MOVE" ||
                active.type === "DIRECTORY_RENAME" ||
                active.type === "DIRECTORY_MOVE"
            ) {
                return active;
            }
            if (active.type === "DIRECTORY_CREATE") {
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

    private async runSync(fullReconciliation: boolean): Promise<SyncSummary> {
        const serverUrl = this.serverUrl();
        let oversized = 0;

        if (serverUrl.length === 0) {
            return unavailable(0, 0);
        }

        try {
            await this.remoteApply.recoverInterruptedApplies();
            const bootstrapRequired =
                !(await this.store.isInitialBootstrapComplete());
            let local: {
                readonly conflicted: number;
                readonly oversized: number;
            };
            let beforePush: PullSummary;

            if (bootstrapRequired) {
                const preManifest = await this.reconcileLocalVault(false);
                oversized = preManifest.oversized;
                let preManifestConflicted = preManifest.conflicted;

                if (
                    !fullReconciliation &&
                    (await this.store.hasStoredOperations())
                ) {
                    const recovered = await this.pull(serverUrl);
                    preManifestConflicted += recovered.conflicted;
                    if (recovered.unavailable) {
                        return unavailable(0, preManifestConflicted, oversized);
                    }
                }

                beforePush = await this.reconcileServerManifest(serverUrl);
                if (beforePush.unavailable) {
                    return unavailable(
                        0,
                        preManifestConflicted + beforePush.conflicted,
                        oversized,
                    );
                }

                local = await this.reconcileLocalVault(true);
                oversized = local.oversized;
                local = {
                    conflicted: preManifestConflicted + local.conflicted,
                    oversized,
                };
                await this.store.completeInitialBootstrap();
            } else {
                local = await this.reconcileLocalVault(false);
                oversized = local.oversized;
                beforePush = fullReconciliation
                    ? await this.reconcileServerManifest(serverUrl)
                    : await this.pull(serverUrl);
            }

            let beforePushConflicted = local.conflicted + beforePush.conflicted;

            if (beforePush.unavailable) {
                return unavailable(0, beforePushConflicted, oversized);
            }
            if (beforePush.historyUnavailable) {
                const reconciled =
                    await this.reconcileServerManifest(serverUrl);
                beforePushConflicted += reconciled.conflicted;
                if (reconciled.unavailable) {
                    return unavailable(0, beforePushConflicted, oversized);
                }
                beforePush = await this.pull(serverUrl);
                beforePushConflicted += beforePush.conflicted;
                if (beforePush.unavailable || beforePush.historyUnavailable) {
                    return unavailable(0, beforePushConflicted, oversized);
                }
            }

            await this.remoteApply.recoverKeepBothResolutions(serverUrl);
            await this.remoteApply.recoverManualMergeResolutions();

            const pushed = await this.push(serverUrl);
            if (pushed.offline) {
                return unavailable(
                    pushed.committed,
                    beforePushConflicted + pushed.conflicted,
                    oversized,
                );
            }

            let afterPush = await this.pull(serverUrl);
            let afterPushConflicted = afterPush.conflicted;
            if (afterPush.unavailable) {
                return unavailable(
                    pushed.committed,
                    beforePushConflicted +
                        pushed.conflicted +
                        afterPushConflicted,
                    oversized,
                );
            }
            if (afterPush.historyUnavailable) {
                const reconciled =
                    await this.reconcileServerManifest(serverUrl);
                afterPushConflicted += reconciled.conflicted;
                if (reconciled.unavailable) {
                    return unavailable(
                        pushed.committed,
                        beforePushConflicted +
                            pushed.conflicted +
                            afterPushConflicted,
                        oversized,
                    );
                }
                afterPush = await this.pull(serverUrl);
                afterPushConflicted += afterPush.conflicted;
                if (afterPush.unavailable || afterPush.historyUnavailable) {
                    return unavailable(
                        pushed.committed,
                        beforePushConflicted +
                            pushed.conflicted +
                            afterPushConflicted,
                        oversized,
                    );
                }
            }

            return {
                committed: pushed.committed,
                conflicted:
                    beforePushConflicted +
                    pushed.conflicted +
                    afterPushConflicted,
                oversized,
                offline: false,
                vaultMismatch: false,
            };
        } catch (error: unknown) {
            if (error instanceof VaultMismatchError) {
                return {
                    committed: 0,
                    conflicted: 0,
                    oversized,
                    offline: false,
                    vaultMismatch: true,
                };
            }

            console.warn("VaultDatum synchronization failed", error);
            return unavailable(0, 0, oversized);
        }
    }

    private async reconcileLocalVault(
        includeInitialUntracked: boolean,
    ): Promise<{
        readonly conflicted: number;
        readonly oversized: number;
    }> {
        const local = new Map<
            string,
            { readonly content: ArrayBuffer; readonly contentHash: string }
        >();
        const localFiles = new Map<string, number>();
        for (const file of await this.localVault.listFiles()) {
            if (isSyncPath(file.path)) {
                localFiles.set(file.path, file.size);
            }
        }
        const localDirectories = new Set(
            (await this.localVault.listDirectories()).filter(isSyncPath),
        );
        const oversizedPaths = new Set(
            [...localFiles.entries()]
                .filter(([, size]) => exceedsSyncContentLimit(size))
                .map(([path]) => path),
        );
        const paths = [...localFiles.keys()]
            .filter((path) => !oversizedPaths.has(path))
            .sort((left, right) => left.localeCompare(right));

        for (const path of paths) {
            const content = await this.localVault.readFile(path);
            if (content !== undefined) {
                local.set(path, {
                    content,
                    contentHash: await contentHash(content),
                });
            }
        }

        await this.store.initializeLocalScan(
            [...local.entries()].map(
                ([path, file]) =>
                    ({
                        path,
                        contentHash: file.contentHash,
                    }) satisfies LocalScanBaseline,
            ),
        );

        let conflicted = 0;
        for (const replica of await this.store.replicas()) {
            if (
                !isSyncPath(replica.path) ||
                (await this.store.hasConflict(replica.path)) ||
                (await this.store.hasStoredOperationForPath(replica.path))
            ) {
                continue;
            }

            if (oversizedPaths.has(replica.path)) {
                if (
                    await this.remoteApply.recordLocalContentTooLarge(
                        replica.path,
                        replica,
                    )
                ) {
                    conflicted += 1;
                }
                continue;
            }

            const file = local.get(replica.path);
            if (replica.state === "PRESENT") {
                if (replica.entryType === "DIRECTORY") {
                    if (file !== undefined) {
                        if (
                            await this.remoteApply.recordLocalDivergence(
                                replica.path,
                                replica,
                            )
                        ) {
                            conflicted += 1;
                        }
                    } else if (!localDirectories.has(replica.path)) {
                        await this.captureDirectoryDelete(replica.path);
                    }
                    continue;
                }
                if (!isPresentFile(replica)) {
                    if (
                        await this.remoteApply.recordLocalDivergence(
                            replica.path,
                            replica,
                        )
                    ) {
                        conflicted += 1;
                    }
                    continue;
                }
                if (file === undefined) {
                    await this.captureDelete(replica.path);
                } else if (file.contentHash !== replica.contentHash) {
                    await this.captureModify(replica.path, file.content);
                }
                continue;
            }

            if (file !== undefined || localDirectories.has(replica.path)) {
                if (
                    await this.remoteApply.recordLocalDivergence(
                        replica.path,
                        replica,
                    )
                ) {
                    conflicted += 1;
                }
            }
        }

        for (const [path, file] of local) {
            if (
                (await this.store.replica(path)) !== undefined ||
                (await this.store.hasConflict(path)) ||
                (await this.store.hasStoredOperationForPath(path))
            ) {
                continue;
            }

            const baseline = await this.store.localScanBaseline(path);
            if (
                !includeInitialUntracked &&
                baseline?.contentHash === file.contentHash
            ) {
                continue;
            }
            await this.captureModify(path, file.content);
        }

        for (const path of localDirectories) {
            if (
                (await this.store.replica(path)) !== undefined ||
                (await this.store.hasConflict(path)) ||
                (await this.store.hasStoredOperationForPath(path))
            ) {
                continue;
            }
            if (
                includeInitialUntracked ||
                (await this.store.localScanBaseline(path)) === undefined
            ) {
                await this.captureDirectoryCreate(path);
            }
        }

        return { conflicted, oversized: oversizedPaths.size };
    }

    private async reconcileServerManifest(
        serverUrl: string,
    ): Promise<PullSummary> {
        const vault = await this.serverClient.readVault(serverUrl);
        if (vault.kind !== "OK") {
            return {
                conflicted: 0,
                unavailable: true,
                historyUnavailable: false,
            };
        }

        const state = await this.store.confirmVault(vault.value.vaultId);
        const created = await this.serverClient.createManifest(serverUrl);
        if (created.kind !== "OK") {
            return {
                conflicted: 0,
                unavailable: true,
                historyUnavailable: false,
            };
        }
        if (created.value.vaultId !== vault.value.vaultId) {
            throw new Error(
                "Server changed Vault identity during manifest creation",
            );
        }

        const manifest = await this.serverClient.readManifest(
            serverUrl,
            created.value.manifestId,
        );
        if (manifest.kind !== "OK") {
            return {
                conflicted: 0,
                unavailable: true,
                historyUnavailable: false,
            };
        }
        validateManifest(created.value, manifest.value, vault.value.vaultId);
        if (manifest.value.snapshotRevision < state.serverCursor) {
            throw new Error("Server manifest predates the local cursor");
        }

        const manifestPaths = new Set<string>();
        for (const entry of manifest.value.entries) {
            if (manifestPaths.has(entry.path)) {
                throw new Error("Server manifest contains duplicate paths");
            }
            manifestPaths.add(entry.path);
        }
        for (const replica of await this.store.replicas()) {
            if (!manifestPaths.has(replica.path)) {
                throw new Error(
                    "Server manifest omitted a path retained by the local replica",
                );
            }
        }

        let conflicted = 0;
        for (const entry of manifest.value.entries) {
            const integrated = await this.remoteApply.integrateManifestEntry(
                serverUrl,
                entry,
            );
            conflicted += integrated.conflicted;
        }
        await this.store.advanceCursor(
            vault.value.vaultId,
            manifest.value.snapshotRevision,
        );
        await this.store.clearCommittedOperations();
        return { conflicted, unavailable: false, historyUnavailable: false };
    }

    private async pull(serverUrl: string): Promise<PullSummary> {
        const vault = await this.serverClient.readVault(serverUrl);

        if (vault.kind !== "OK") {
            return {
                conflicted: 0,
                unavailable: true,
                historyUnavailable: false,
            };
        }

        let state = await this.store.confirmVault(vault.value.vaultId);
        let conflicted = 0;

        if (
            state.serverCursor === 0 &&
            vault.value.currentRevision > 0 &&
            !(await this.store.hasStoredOperations())
        ) {
            const initial = await this.initializeFromManifest(
                serverUrl,
                vault.value.vaultId,
            );
            if (initial.unavailable) {
                return initial;
            }
            conflicted += initial.conflicted;
            state = await this.store.syncState();
        }

        if (state.serverCursor >= vault.value.currentRevision) {
            return {
                conflicted,
                unavailable: false,
                historyUnavailable: false,
            };
        }

        let cursor = state.serverCursor;
        const changes: RemoteChange[] = [];

        while (cursor < vault.value.currentRevision) {
            const page = await this.serverClient.listChanges(
                serverUrl,
                cursor,
                500,
            );

            if (page.kind === "HISTORY_NOT_AVAILABLE") {
                return {
                    conflicted,
                    unavailable: false,
                    historyUnavailable: true,
                };
            }
            if (page.kind !== "OK") {
                return {
                    conflicted,
                    unavailable: true,
                    historyUnavailable: false,
                };
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
        return { conflicted, unavailable: false, historyUnavailable: false };
    }

    private async initializeFromManifest(
        serverUrl: string,
        vaultId: string,
    ): Promise<PullSummary> {
        const created = await this.serverClient.createManifest(serverUrl);
        if (created.kind !== "OK") {
            return {
                conflicted: 0,
                unavailable: true,
                historyUnavailable: false,
            };
        }
        if (created.value.vaultId !== vaultId) {
            throw new Error(
                "Server changed Vault identity during manifest creation",
            );
        }

        const manifest = await this.serverClient.readManifest(
            serverUrl,
            created.value.manifestId,
        );
        if (manifest.kind !== "OK") {
            return {
                conflicted: 0,
                unavailable: true,
                historyUnavailable: false,
            };
        }
        validateManifest(created.value, manifest.value, vaultId);

        let conflicted = 0;
        for (const entry of manifest.value.entries) {
            const integrated = await this.remoteApply.integrateManifestEntry(
                serverUrl,
                entry,
            );
            conflicted += integrated.conflicted;
        }
        await this.store.advanceCursor(
            vaultId,
            manifest.value.snapshotRevision,
        );
        return { conflicted, unavailable: false, historyUnavailable: false };
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
        if (pending.type === "RENAME") {
            return this.serverClient.submitRename(serverUrl, pending);
        }
        if (pending.type === "MOVE") {
            return this.serverClient.submitMove(serverUrl, pending);
        }
        if (pending.type === "DIRECTORY_CREATE") {
            return this.serverClient.submitDirectoryCreate(serverUrl, pending);
        }
        if (pending.type === "DIRECTORY_DELETE") {
            return this.serverClient.submitDirectoryDelete(serverUrl, pending);
        }
        if (pending.type === "DIRECTORY_RENAME") {
            return this.serverClient.submitDirectoryRename(serverUrl, pending);
        }
        if (pending.type === "DIRECTORY_MOVE") {
            return this.serverClient.submitDirectoryMove(serverUrl, pending);
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

    private async hasPresentDescendants(path: string): Promise<boolean> {
        const prefix = `${path}/`;
        return (await this.store.replicas()).some(
            (entry) =>
                entry.path.startsWith(prefix) && entry.state === "PRESENT",
        );
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

function parentPath(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
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

function validateManifest(
    created: RemoteManifestCreated,
    manifest: RemoteManifest,
    vaultId: string,
): void {
    if (
        manifest.manifestId !== created.manifestId ||
        manifest.vaultId !== vaultId ||
        created.vaultId !== vaultId ||
        manifest.snapshotRevision !== created.snapshotRevision ||
        manifest.expiresAt !== created.expiresAt
    ) {
        throw new Error("Server returned inconsistent manifest metadata");
    }
}

function unavailable(
    committed: number,
    conflicted: number,
    oversized = 0,
): SyncSummary {
    return {
        committed,
        conflicted,
        oversized,
        offline: true,
        vaultMismatch: false,
    };
}
