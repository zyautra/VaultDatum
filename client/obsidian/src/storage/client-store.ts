export type PendingStatus = "READY" | "IN_FLIGHT" | "CONFLICT" | "COMMITTED";

interface PendingOperationBase {
    readonly operationId: string;
    readonly clientId: string;
    readonly path: string;
    readonly createdAt: string;
    readonly status: PendingStatus;
    readonly failureCode?: string;
}

interface PendingContentOperation extends PendingOperationBase {
    readonly contentHash: string;
    readonly size: number;
    readonly artifactId: string;
}

export interface PendingCreate extends PendingContentOperation {
    readonly type: "CREATE";
    readonly base:
        | { readonly state: "UNKNOWN" }
        | { readonly state: "DELETED"; readonly revision: number };
}

export interface PendingModify extends PendingContentOperation {
    readonly type: "MODIFY";
    readonly baseRevision: number;
    readonly baseContentHash: string;
}

export interface PendingDelete extends PendingOperationBase {
    readonly type: "DELETE";
    readonly baseRevision: number;
    readonly baseContentHash: string;
}

export interface PendingRename extends PendingOperationBase {
    readonly type: "RENAME";
    readonly destinationPath: string;
    readonly baseRevision: number;
    readonly baseContentHash: string;
}

export interface PendingMove extends PendingOperationBase {
    readonly type: "MOVE";
    readonly destinationPath: string;
    readonly baseRevision: number;
    readonly baseContentHash: string;
}

export interface PendingDirectoryCreate extends PendingOperationBase {
    readonly type: "DIRECTORY_CREATE";
}

export interface PendingDirectoryDelete extends PendingOperationBase {
    readonly type: "DIRECTORY_DELETE";
    readonly baseRevision: number;
}

export interface PendingDirectoryRename extends PendingOperationBase {
    readonly type: "DIRECTORY_RENAME";
    readonly destinationPath: string;
    readonly baseRevision: number;
}

export interface PendingDirectoryMove extends PendingOperationBase {
    readonly type: "DIRECTORY_MOVE";
    readonly destinationPath: string;
    readonly baseRevision: number;
}

export type PendingOperation =
    | PendingCreate
    | PendingModify
    | PendingDelete
    | PendingRename
    | PendingMove
    | PendingDirectoryCreate
    | PendingDirectoryDelete
    | PendingDirectoryRename
    | PendingDirectoryMove;
export type ReplicaState = "PRESENT" | "DELETED";

export interface ReplicaEntry {
    readonly path: string;
    readonly entryType: "FILE" | "DIRECTORY";
    readonly state: ReplicaState;
    readonly revision: number;
    readonly contentHash?: string;
    readonly size?: number;
}

export interface ClientSyncState {
    readonly vaultId?: string;
    readonly serverCursor: number;
}

export interface ApplyIntent {
    readonly applyId: string;
    readonly path: string;
    readonly before?: ReplicaEntry;
    readonly after: ReplicaEntry;
    readonly phase: "PREPARED" | "CONTENT_READY";
    readonly artifactId?: string;
}

export interface RemoteConflict {
    readonly conflictId: string;
    readonly path: string;
    readonly revision: number;
    readonly code: string;
    readonly serverState: ReplicaEntry;
    readonly operationId?: string;
}

export interface KeepBothResolution {
    readonly resolutionId: string;
    readonly sourcePath: string;
    readonly pending: PendingCreate;
    readonly phase: "COPYING" | "APPLYING_SERVER";
}

export interface ManualMergeResolution {
    readonly resolutionId: string;
    readonly path: string;
    readonly sourceContentHash: string;
    readonly pending: PendingModify;
}

export class VaultMismatchError extends Error {
    public constructor(expectedVaultId: string, actualVaultId: string) {
        super(
            `VaultDatum sync state belongs to ${expectedVaultId}, not ${actualVaultId}.`,
        );
    }
}

interface ClientIdMetadata {
    readonly key: "client-id";
    readonly value: string;
}

interface SyncStateMetadata {
    readonly key: "sync-state";
    readonly value: ClientSyncState;
}

interface LocalScanMetadata {
    readonly key: "local-scan-initialized";
    readonly value: true;
}

export interface LocalScanBaseline {
    readonly path: string;
    readonly contentHash: string;
}

interface Artifact {
    readonly artifactId: string;
    readonly content: Blob;
}

const DATABASE_VERSION = 5;
const METADATA_STORE = "metadata";
const PENDING_STORE = "pending";
const ARTIFACT_STORE = "artifact";
const REPLICA_STORE = "replica";
const LOCAL_SCAN_STORE = "local-scan";
const APPLY_STORE = "apply";
const CONFLICT_STORE = "conflict";
const KEEP_BOTH_STORE = "keep-both";
const MANUAL_MERGE_STORE = "manual-merge";

export class ClientStore {
    private constructor(private readonly database: IDBDatabase) {}

    public static async open(databaseName: string): Promise<ClientStore> {
        return new ClientStore(await openDatabase(databaseName));
    }

    public close(): void {
        this.database.close();
    }

    public async clientId(): Promise<string> {
        const metadata = await this.metadata<ClientIdMetadata>("client-id");

        if (metadata?.value.length) {
            return metadata.value;
        }

        const clientId = `C-${crypto.randomUUID()}`;
        await this.saveMetadata({ key: "client-id", value: clientId });
        return clientId;
    }

    public async syncState(): Promise<ClientSyncState> {
        const metadata = await this.metadata<SyncStateMetadata>("sync-state");

        if (
            metadata !== undefined &&
            typeof metadata.value.serverCursor === "number" &&
            Number.isSafeInteger(metadata.value.serverCursor) &&
            metadata.value.serverCursor >= 0
        ) {
            return metadata.value;
        }

        return { serverCursor: 0 };
    }

    public async confirmVault(vaultId: string): Promise<ClientSyncState> {
        const state = await this.syncState();

        if (state.vaultId !== undefined && state.vaultId !== vaultId) {
            throw new VaultMismatchError(state.vaultId, vaultId);
        }
        if (state.vaultId === vaultId) {
            return state;
        }

        const confirmed = { ...state, vaultId };
        await this.saveMetadata({ key: "sync-state", value: confirmed });
        return confirmed;
    }

    public async advanceCursor(
        vaultId: string,
        serverCursor: number,
    ): Promise<void> {
        const state = await this.confirmVault(vaultId);

        if (
            !Number.isSafeInteger(serverCursor) ||
            serverCursor < state.serverCursor
        ) {
            throw new Error(
                "VaultDatum server cursor must advance monotonically",
            );
        }

        await this.saveMetadata({
            key: "sync-state",
            value: { vaultId, serverCursor },
        });
    }

    public async findActiveOperation(
        path: string,
    ): Promise<PendingOperation | undefined> {
        const records = await this.pendingRecords();
        return records.find(
            (record) =>
                affectsPath(record, path) &&
                (record.status === "READY" || record.status === "IN_FLIGHT"),
        );
    }

    public async pendingForPath(
        path: string,
    ): Promise<PendingOperation | undefined> {
        const records = await this.pendingRecords();
        return records.find(
            (record) =>
                affectsPath(record, path) && record.status !== "COMMITTED",
        );
    }

    public async operation(
        operationId: string,
    ): Promise<PendingOperation | undefined> {
        return this.pending(operationId);
    }

    public async create(
        operationId: string,
    ): Promise<PendingOperation | undefined> {
        return this.operation(operationId);
    }

    public async saveContentOperation(
        pending: PendingContentOperation,
        content: Blob,
    ): Promise<void> {
        const transaction = this.database.transaction(
            [PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(ARTIFACT_STORE).put({
            artifactId: pending.artifactId,
            content,
        } satisfies Artifact);
        transaction.objectStore(PENDING_STORE).put(pending);
        await transactionDone(transaction);
    }

    public async saveCreate(
        pending: PendingCreate,
        content: Blob,
    ): Promise<void> {
        await this.saveContentOperation(pending, content);
    }

    public async saveDelete(pending: PendingDelete): Promise<void> {
        await this.put(PENDING_STORE, pending);
    }

    public async savePathChange(
        pending: PendingRename | PendingMove,
    ): Promise<void> {
        await this.put(PENDING_STORE, pending);
    }

    public async saveDirectoryOperation(
        pending:
            | PendingDirectoryCreate
            | PendingDirectoryDelete
            | PendingDirectoryRename
            | PendingDirectoryMove,
    ): Promise<void> {
        await this.put(PENDING_STORE, pending);
    }

    public async pendingOperations(): Promise<PendingOperation[]> {
        const records = await this.pendingRecords();
        return records
            .filter(
                (record) =>
                    record.status === "READY" || record.status === "IN_FLIGHT",
            )
            .sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            );
    }

    public async hasStoredOperations(): Promise<boolean> {
        return (await this.pendingRecords()).length > 0;
    }

    public async markInFlight(operationId: string): Promise<void> {
        await this.updatePending(operationId, (pending) => ({
            ...pending,
            status: "IN_FLIGHT",
            failureCode: undefined,
        }));
    }

    public async markConflict(
        operationId: string,
        failureCode: string,
    ): Promise<void> {
        await this.updatePending(operationId, (pending) => ({
            ...pending,
            status: "CONFLICT",
            failureCode,
        }));
    }

    public async markCommitted(operationId: string): Promise<void> {
        const pending = await this.pending(operationId);

        if (pending === undefined) {
            return;
        }

        const transaction = this.database.transaction(
            [PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(PENDING_STORE).put({
            ...pending,
            status: "COMMITTED",
            failureCode: undefined,
        } satisfies PendingOperation);
        if (isContentOperation(pending)) {
            transaction.objectStore(ARTIFACT_STORE).delete(pending.artifactId);
        }
        await transactionDone(transaction);
    }

    public async completeObservedOperation(operationId: string): Promise<void> {
        const pending = await this.pending(operationId);

        if (pending === undefined) {
            return;
        }

        const transaction = this.database.transaction(
            [PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(PENDING_STORE).delete(operationId);
        if (isContentOperation(pending)) {
            transaction.objectStore(ARTIFACT_STORE).delete(pending.artifactId);
        }
        await transactionDone(transaction);
    }

    public async discardPending(operationId: string): Promise<void> {
        const pending = await this.pending(operationId);

        if (pending === undefined) {
            return;
        }

        const transaction = this.database.transaction(
            [PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(PENDING_STORE).delete(operationId);
        if (isContentOperation(pending)) {
            transaction.objectStore(ARTIFACT_STORE).delete(pending.artifactId);
        }
        await transactionDone(transaction);
    }

    public async artifact(artifactId: string): Promise<Blob | undefined> {
        const artifact = await this.value<Artifact>(ARTIFACT_STORE, artifactId);
        return artifact?.content;
    }

    public async replica(path: string): Promise<ReplicaEntry | undefined> {
        return this.value<ReplicaEntry>(REPLICA_STORE, path);
    }

    public async putReplica(entry: ReplicaEntry): Promise<void> {
        await this.put(REPLICA_STORE, entry);
    }

    public async replicas(): Promise<ReplicaEntry[]> {
        return (await this.values<ReplicaEntry>(REPLICA_STORE)).sort(
            (left, right) => left.path.localeCompare(right.path),
        );
    }

    public async initializeLocalScan(
        baseline: readonly LocalScanBaseline[],
    ): Promise<boolean> {
        const initialized = await this.metadata<LocalScanMetadata>(
            "local-scan-initialized",
        );
        if (initialized?.value === true) {
            return false;
        }

        const transaction = this.database.transaction(
            [METADATA_STORE, LOCAL_SCAN_STORE],
            "readwrite",
        );
        for (const entry of baseline) {
            transaction.objectStore(LOCAL_SCAN_STORE).put(entry);
        }
        transaction.objectStore(METADATA_STORE).put({
            key: "local-scan-initialized",
            value: true,
        } satisfies LocalScanMetadata);
        await transactionDone(transaction);
        return true;
    }

    public async localScanBaseline(
        path: string,
    ): Promise<LocalScanBaseline | undefined> {
        return this.value<LocalScanBaseline>(LOCAL_SCAN_STORE, path);
    }

    public async hasStoredOperationForPath(path: string): Promise<boolean> {
        return (await this.pendingRecords()).some((record) =>
            affectsPath(record, path),
        );
    }

    public async clearCommittedOperations(): Promise<void> {
        const committed = (await this.pendingRecords()).filter(
            (record) => record.status === "COMMITTED",
        );
        if (committed.length === 0) {
            return;
        }

        const transaction = this.database.transaction(
            [PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        for (const pending of committed) {
            this.discardPendingInTransaction(transaction, pending);
        }
        await transactionDone(transaction);
    }

    public async applyIntents(): Promise<ApplyIntent[]> {
        return this.values<ApplyIntent>(APPLY_STORE);
    }

    public async prepareApply(intent: ApplyIntent): Promise<void> {
        await this.put(APPLY_STORE, intent);
    }

    public async stageApplyContent(
        intent: ApplyIntent,
        content: Blob,
    ): Promise<ApplyIntent> {
        const artifactId = intent.artifactId;
        if (
            intent.phase !== "PREPARED" ||
            intent.after.state !== "PRESENT" ||
            artifactId === undefined
        ) {
            throw new Error("Only a prepared file apply can stage content");
        }

        const staged: ApplyIntent = { ...intent, phase: "CONTENT_READY" };
        const transaction = this.database.transaction(
            [APPLY_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(ARTIFACT_STORE).put({
            artifactId,
            content,
        } satisfies Artifact);
        transaction.objectStore(APPLY_STORE).put(staged);
        await transactionDone(transaction);
        return staged;
    }

    public async applyContent(intent: ApplyIntent): Promise<Blob | undefined> {
        if (
            intent.phase !== "CONTENT_READY" ||
            intent.artifactId === undefined
        ) {
            return undefined;
        }
        return this.artifact(intent.artifactId);
    }

    public async discardApply(intent: ApplyIntent): Promise<void> {
        const transaction = this.database.transaction(
            [APPLY_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(APPLY_STORE).delete(intent.applyId);
        if (intent.artifactId !== undefined) {
            transaction.objectStore(ARTIFACT_STORE).delete(intent.artifactId);
        }
        await transactionDone(transaction);
    }

    public async completeApply(intent: ApplyIntent): Promise<void> {
        const transaction = this.database.transaction(
            [APPLY_STORE, ARTIFACT_STORE, REPLICA_STORE],
            "readwrite",
        );
        transaction.objectStore(REPLICA_STORE).put(intent.after);
        transaction.objectStore(APPLY_STORE).delete(intent.applyId);
        if (intent.artifactId !== undefined) {
            transaction.objectStore(ARTIFACT_STORE).delete(intent.artifactId);
        }
        await transactionDone(transaction);
    }

    public async hasPreparedRemoteApply(
        path: string,
        contentHash: string,
    ): Promise<boolean> {
        const intents = await this.applyIntents();
        return intents.some(
            (intent) =>
                intent.path === path &&
                intent.after.state === "PRESENT" &&
                intent.after.contentHash === contentHash,
        );
    }

    public async hasPreparedRemoteDelete(path: string): Promise<boolean> {
        const intents = await this.applyIntents();
        return intents.some(
            (intent) =>
                intent.path === path && intent.after.state === "DELETED",
        );
    }

    public async hasPreparedRemoteDirectoryApply(
        path: string,
    ): Promise<boolean> {
        const intents = await this.applyIntents();
        return intents.some(
            (intent) =>
                intent.path === path &&
                intent.after.entryType === "DIRECTORY" &&
                intent.after.state === "PRESENT",
        );
    }

    public async hasConflict(path: string): Promise<boolean> {
        return (await this.conflict(path)) !== undefined;
    }

    public async conflicts(): Promise<RemoteConflict[]> {
        return (await this.values<RemoteConflict>(CONFLICT_STORE)).sort(
            (left, right) => right.revision - left.revision,
        );
    }

    public async conflict(path: string): Promise<RemoteConflict | undefined> {
        return (await this.conflicts()).find(
            (conflict) => conflict.path === path,
        );
    }

    public async clearConflicts(path: string): Promise<void> {
        const conflicts = await this.conflictsForPath(path);
        if (conflicts.length === 0) {
            return;
        }

        const transaction = this.database.transaction(
            CONFLICT_STORE,
            "readwrite",
        );
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        await transactionDone(transaction);
    }

    public async discardPendingAndClearConflicts(path: string): Promise<void> {
        const pending = await this.pendingForPath(path);
        const conflicts = await this.conflictsForPath(path);
        const transaction = this.database.transaction(
            [CONFLICT_STORE, PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        this.discardPendingInTransaction(transaction, pending);
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        await transactionDone(transaction);
    }

    public async replaceConflictWithModify(
        pending: PendingModify,
        content: Blob,
    ): Promise<void> {
        const replaced = await this.pendingForPath(pending.path);
        const conflicts = await this.conflictsForPath(pending.path);
        const transaction = this.database.transaction(
            [CONFLICT_STORE, PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        this.discardPendingInTransaction(transaction, replaced);
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        transaction.objectStore(ARTIFACT_STORE).put({
            artifactId: pending.artifactId,
            content,
        } satisfies Artifact);
        transaction.objectStore(PENDING_STORE).put(pending);
        await transactionDone(transaction);
    }

    public async replaceConflictWithCreate(
        pending: PendingCreate,
        content: Blob,
    ): Promise<void> {
        const replaced = await this.pendingForPath(pending.path);
        const conflicts = await this.conflictsForPath(pending.path);
        const transaction = this.database.transaction(
            [CONFLICT_STORE, PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        this.discardPendingInTransaction(transaction, replaced);
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        transaction.objectStore(ARTIFACT_STORE).put({
            artifactId: pending.artifactId,
            content,
        } satisfies Artifact);
        transaction.objectStore(PENDING_STORE).put(pending);
        await transactionDone(transaction);
    }

    public async replaceConflictWithDelete(
        pending: PendingDelete,
    ): Promise<void> {
        const replaced = await this.pendingForPath(pending.path);
        const conflicts = await this.conflictsForPath(pending.path);
        const transaction = this.database.transaction(
            [CONFLICT_STORE, PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        this.discardPendingInTransaction(transaction, replaced);
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        transaction.objectStore(PENDING_STORE).put(pending);
        await transactionDone(transaction);
    }

    public async keepBothResolutions(): Promise<KeepBothResolution[]> {
        return (await this.values<KeepBothResolution>(KEEP_BOTH_STORE)).sort(
            (left, right) =>
                left.pending.createdAt.localeCompare(right.pending.createdAt),
        );
    }

    public async beginKeepBothResolution(
        resolution: KeepBothResolution,
        content: Blob,
    ): Promise<void> {
        const transaction = this.database.transaction(
            [KEEP_BOTH_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(ARTIFACT_STORE).put({
            artifactId: resolution.pending.artifactId,
            content,
        } satisfies Artifact);
        transaction.objectStore(KEEP_BOTH_STORE).put(resolution);
        await transactionDone(transaction);
    }

    public async markKeepBothCopyReady(
        resolution: KeepBothResolution,
    ): Promise<KeepBothResolution> {
        if (resolution.phase !== "COPYING") {
            return resolution;
        }

        const ready: KeepBothResolution = {
            ...resolution,
            phase: "APPLYING_SERVER",
        };
        const transaction = this.database.transaction(
            [KEEP_BOTH_STORE, PENDING_STORE],
            "readwrite",
        );
        transaction.objectStore(PENDING_STORE).put(ready.pending);
        transaction.objectStore(KEEP_BOTH_STORE).put(ready);
        await transactionDone(transaction);
        return ready;
    }

    public async completeKeepBothResolution(
        resolution: KeepBothResolution,
    ): Promise<void> {
        const replaced = await this.pendingForPath(resolution.sourcePath);
        const conflicts = await this.conflictsForPath(resolution.sourcePath);
        const transaction = this.database.transaction(
            [KEEP_BOTH_STORE, CONFLICT_STORE, PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        this.discardPendingInTransaction(transaction, replaced);
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        transaction
            .objectStore(KEEP_BOTH_STORE)
            .delete(resolution.resolutionId);
        await transactionDone(transaction);
    }

    public async manualMergeResolutions(): Promise<ManualMergeResolution[]> {
        return this.values<ManualMergeResolution>(MANUAL_MERGE_STORE);
    }

    public async beginManualMergeResolution(
        resolution: ManualMergeResolution,
        content: Blob,
    ): Promise<void> {
        const transaction = this.database.transaction(
            [MANUAL_MERGE_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(ARTIFACT_STORE).put({
            artifactId: resolution.pending.artifactId,
            content,
        } satisfies Artifact);
        transaction.objectStore(MANUAL_MERGE_STORE).put(resolution);
        await transactionDone(transaction);
    }

    public async completeManualMergeResolution(
        resolution: ManualMergeResolution,
    ): Promise<void> {
        const replaced = await this.pendingForPath(resolution.path);
        const conflicts = await this.conflictsForPath(resolution.path);
        const transaction = this.database.transaction(
            [MANUAL_MERGE_STORE, CONFLICT_STORE, PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        this.discardPendingInTransaction(transaction, replaced);
        for (const conflict of conflicts) {
            transaction.objectStore(CONFLICT_STORE).delete(conflict.conflictId);
        }
        transaction.objectStore(PENDING_STORE).put(resolution.pending);
        transaction
            .objectStore(MANUAL_MERGE_STORE)
            .delete(resolution.resolutionId);
        await transactionDone(transaction);
    }

    public async recordRemoteConflict(
        conflict: RemoteConflict,
        serverState: ReplicaEntry,
        pending?: PendingOperation,
    ): Promise<void> {
        const transaction = this.database.transaction(
            [CONFLICT_STORE, PENDING_STORE, REPLICA_STORE],
            "readwrite",
        );
        transaction.objectStore(CONFLICT_STORE).put(conflict);
        transaction.objectStore(REPLICA_STORE).put(serverState);

        if (pending !== undefined) {
            transaction.objectStore(PENDING_STORE).put({
                ...pending,
                status: "CONFLICT",
                failureCode: conflict.code,
            } satisfies PendingOperation);
        }

        await transactionDone(transaction);
    }

    private async metadata<T>(key: string): Promise<T | undefined> {
        return this.value<T>(METADATA_STORE, key);
    }

    private async saveMetadata(
        metadata: ClientIdMetadata | SyncStateMetadata | LocalScanMetadata,
    ): Promise<void> {
        await this.put(METADATA_STORE, metadata);
    }

    private async pendingRecords(): Promise<PendingOperation[]> {
        return this.values<PendingOperation>(PENDING_STORE);
    }

    private async conflictsForPath(path: string): Promise<RemoteConflict[]> {
        return (await this.conflicts()).filter(
            (conflict) => conflict.path === path,
        );
    }

    private discardPendingInTransaction(
        transaction: IDBTransaction,
        pending: PendingOperation | undefined,
    ): void {
        if (pending === undefined) {
            return;
        }

        transaction.objectStore(PENDING_STORE).delete(pending.operationId);
        if (isContentOperation(pending)) {
            transaction.objectStore(ARTIFACT_STORE).delete(pending.artifactId);
        }
    }

    private async pending(
        operationId: string,
    ): Promise<PendingOperation | undefined> {
        return this.value<PendingOperation>(PENDING_STORE, operationId);
    }

    private async updatePending(
        operationId: string,
        update: (pending: PendingOperation) => PendingOperation,
    ): Promise<void> {
        const pending = await this.pending(operationId);

        if (pending !== undefined) {
            await this.put(PENDING_STORE, update(pending));
        }
    }

    private async value<T>(
        storeName: string,
        key: IDBValidKey,
    ): Promise<T | undefined> {
        const transaction = this.database.transaction(storeName, "readonly");
        const value = await requestValue<T | undefined>(
            transaction.objectStore(storeName).get(key),
        );
        await transactionDone(transaction);
        return value;
    }

    private async values<T>(storeName: string): Promise<T[]> {
        const transaction = this.database.transaction(storeName, "readonly");
        const values = await requestValue<T[]>(
            transaction.objectStore(storeName).getAll(),
        );
        await transactionDone(transaction);
        return values;
    }

    private async put(storeName: string, value: unknown): Promise<void> {
        const transaction = this.database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value);
        await transactionDone(transaction);
    }

    private async delete(storeName: string, key: IDBValidKey): Promise<void> {
        const transaction = this.database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(key);
        await transactionDone(transaction);
    }
}

function isContentOperation(
    pending: PendingOperation,
): pending is PendingCreate | PendingModify {
    return pending.type === "CREATE" || pending.type === "MODIFY";
}

function affectsPath(pending: PendingOperation, path: string): boolean {
    return (
        pending.path === path ||
        (isPathChange(pending) && pending.destinationPath === path)
    );
}

function isPathChange(
    pending: PendingOperation,
): pending is
    | PendingRename
    | PendingMove
    | PendingDirectoryRename
    | PendingDirectoryMove {
    return (
        pending.type === "RENAME" ||
        pending.type === "MOVE" ||
        pending.type === "DIRECTORY_RENAME" ||
        pending.type === "DIRECTORY_MOVE"
    );
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, DATABASE_VERSION);

        request.onupgradeneeded = (): void => {
            const database = request.result;

            if (!database.objectStoreNames.contains(METADATA_STORE)) {
                database.createObjectStore(METADATA_STORE, { keyPath: "key" });
            }
            if (!database.objectStoreNames.contains(PENDING_STORE)) {
                const pending = database.createObjectStore(PENDING_STORE, {
                    keyPath: "operationId",
                });
                pending.createIndex("path", "path", { unique: false });
                pending.createIndex("status", "status", { unique: false });
            }
            if (!database.objectStoreNames.contains(ARTIFACT_STORE)) {
                database.createObjectStore(ARTIFACT_STORE, {
                    keyPath: "artifactId",
                });
            }
            if (!database.objectStoreNames.contains(REPLICA_STORE)) {
                database.createObjectStore(REPLICA_STORE, { keyPath: "path" });
            }
            if (!database.objectStoreNames.contains(LOCAL_SCAN_STORE)) {
                database.createObjectStore(LOCAL_SCAN_STORE, {
                    keyPath: "path",
                });
            }
            if (!database.objectStoreNames.contains(APPLY_STORE)) {
                const apply = database.createObjectStore(APPLY_STORE, {
                    keyPath: "applyId",
                });
                apply.createIndex("path", "path", { unique: false });
            }
            if (!database.objectStoreNames.contains(CONFLICT_STORE)) {
                const conflict = database.createObjectStore(CONFLICT_STORE, {
                    keyPath: "conflictId",
                });
                conflict.createIndex("path", "path", { unique: false });
            }
            if (!database.objectStoreNames.contains(KEEP_BOTH_STORE)) {
                database.createObjectStore(KEEP_BOTH_STORE, {
                    keyPath: "resolutionId",
                });
            }
            if (!database.objectStoreNames.contains(MANUAL_MERGE_STORE)) {
                database.createObjectStore(MANUAL_MERGE_STORE, {
                    keyPath: "resolutionId",
                });
            }
        };
        request.onsuccess = (): void => resolve(request.result);
        request.onerror = (): void =>
            reject(
                request.error ??
                    new Error("Could not open VaultDatum sync storage"),
            );
        request.onblocked = (): void =>
            reject(
                new Error(
                    "VaultDatum sync storage is blocked by another open version",
                ),
            );
    });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = (): void => resolve(request.result);
        request.onerror = (): void =>
            reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = (): void => resolve();
        transaction.onabort = (): void =>
            reject(
                transaction.error ?? new Error("IndexedDB transaction aborted"),
            );
        transaction.onerror = (): void =>
            reject(
                transaction.error ?? new Error("IndexedDB transaction failed"),
            );
    });
}
