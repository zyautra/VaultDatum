export type PendingStatus = "READY" | "IN_FLIGHT" | "CONFLICT";

export interface PendingCreate {
    readonly operationId: string;
    readonly clientId: string;
    readonly type: "CREATE";
    readonly path: string;
    readonly contentHash: string;
    readonly size: number;
    readonly artifactId: string;
    readonly createdAt: string;
    readonly status: PendingStatus;
    readonly failureCode?: string;
}

interface ClientMetadata {
    readonly key: "client-id";
    readonly value: string;
}

interface Artifact {
    readonly artifactId: string;
    readonly content: Blob;
}

const DATABASE_VERSION = 1;
const METADATA_STORE = "metadata";
const PENDING_STORE = "pending";
const ARTIFACT_STORE = "artifact";

export class ClientStore {
    private constructor(private readonly database: IDBDatabase) {}

    public static async open(databaseName: string): Promise<ClientStore> {
        const database = await openDatabase(databaseName);
        return new ClientStore(database);
    }

    public close(): void {
        this.database.close();
    }

    public async clientId(): Promise<string> {
        const transaction = this.database.transaction(
            METADATA_STORE,
            "readonly",
        );
        const metadata = await requestValue<ClientMetadata | undefined>(
            transaction.objectStore(METADATA_STORE).get("client-id"),
        );
        await transactionDone(transaction);

        if (
            metadata !== undefined &&
            typeof metadata.value === "string" &&
            metadata.value.length > 0
        ) {
            return metadata.value;
        }

        const clientId = `C-${crypto.randomUUID()}`;
        const writeTransaction = this.database.transaction(
            METADATA_STORE,
            "readwrite",
        );
        writeTransaction.objectStore(METADATA_STORE).put({
            key: "client-id",
            value: clientId,
        } satisfies ClientMetadata);
        await transactionDone(writeTransaction);
        return clientId;
    }

    public async findActiveCreate(
        path: string,
    ): Promise<PendingCreate | undefined> {
        const records = await this.pendingRecords();
        return records.find((record) => record.path === path);
    }

    public async saveCreate(
        pending: PendingCreate,
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

    public async pendingCreates(): Promise<PendingCreate[]> {
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

    public async artifact(artifactId: string): Promise<Blob | undefined> {
        const transaction = this.database.transaction(
            ARTIFACT_STORE,
            "readonly",
        );
        const artifact = await requestValue<Artifact | undefined>(
            transaction.objectStore(ARTIFACT_STORE).get(artifactId),
        );
        await transactionDone(transaction);
        return artifact?.content;
    }

    public async removeCommitted(
        operationId: string,
        artifactId: string,
    ): Promise<void> {
        const transaction = this.database.transaction(
            [PENDING_STORE, ARTIFACT_STORE],
            "readwrite",
        );
        transaction.objectStore(PENDING_STORE).delete(operationId);
        transaction.objectStore(ARTIFACT_STORE).delete(artifactId);
        await transactionDone(transaction);
    }

    private async pendingRecords(): Promise<PendingCreate[]> {
        const transaction = this.database.transaction(
            PENDING_STORE,
            "readonly",
        );
        const records = await requestValue<PendingCreate[]>(
            transaction.objectStore(PENDING_STORE).getAll(),
        );
        await transactionDone(transaction);
        return records;
    }

    private async updatePending(
        operationId: string,
        update: (pending: PendingCreate) => PendingCreate,
    ): Promise<void> {
        const pending = await this.pending(operationId);

        if (pending !== undefined) {
            const transaction = this.database.transaction(
                PENDING_STORE,
                "readwrite",
            );
            transaction.objectStore(PENDING_STORE).put(update(pending));
            await transactionDone(transaction);
        }
    }

    private async pending(
        operationId: string,
    ): Promise<PendingCreate | undefined> {
        const transaction = this.database.transaction(
            PENDING_STORE,
            "readonly",
        );
        const pending = await requestValue<PendingCreate | undefined>(
            transaction.objectStore(PENDING_STORE).get(operationId),
        );
        await transactionDone(transaction);
        return pending;
    }
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
