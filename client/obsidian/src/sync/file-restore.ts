import { contentHash } from "../core/content-hash";
import { exceedsSyncContentLimit } from "../core/content-limits";
import type {
    ClientStore,
    PendingCreate,
    PendingOperation,
} from "../storage/client-store";
import type {
    HistoryTransport,
    ReadResult,
    RemoteHistoryEntry,
    RemoteHistoryPage,
} from "../transport/server-client";
import type { LocalVault } from "./remote-apply";

export type RestoreBlockedReason =
    | "CONFLICT"
    | "PENDING"
    | "OUT_OF_SYNC"
    | "PATH_OCCUPIED"
    | "UNKNOWN_PATH"
    | "TOO_LARGE"
    | "ALREADY_CURRENT";

export type RestoreOutcome =
    | { readonly kind: "QUEUED" }
    | { readonly kind: "UNAVAILABLE" }
    | { readonly kind: "NOT_RETAINED" }
    | { readonly kind: "BLOCKED"; readonly reason: RestoreBlockedReason };

type CaptureContent = (
    path: string,
    content: ArrayBuffer,
) => Promise<PendingOperation | undefined>;

/**
 * Restores one file to a retained version by queuing an ordinary pending operation.
 *
 * A present file is rewritten locally and captured as a MODIFY against the
 * replicated server state. A deleted file is rewritten locally and queued as
 * an explicit restore CREATE. Both then follow the normal durable push path,
 * so retries, conflicts, and recovery need no special handling.
 */
export class FileRestore {
    public constructor(
        private readonly store: ClientStore,
        private readonly transport: HistoryTransport,
        private readonly localVault: LocalVault,
        private readonly serverUrl: () => string,
        private readonly captureContent: CaptureContent,
    ) {}

    public history(
        path: string,
        before?: number,
    ): Promise<ReadResult<RemoteHistoryPage>> {
        return this.transport.listFileHistory(
            this.requireServerUrl(),
            path,
            before,
        );
    }

    public async restore(
        path: string,
        entry: RemoteHistoryEntry,
    ): Promise<RestoreOutcome> {
        if (
            entry.state !== "PRESENT" ||
            entry.contentHash === undefined ||
            !entry.contentAvailable
        ) {
            return { kind: "NOT_RETAINED" };
        }

        const blocked = await this.blockedReason(path, entry);
        if (blocked !== undefined) {
            return { kind: "BLOCKED", reason: blocked };
        }

        const download = await this.transport.downloadHistoryContent(
            this.requireServerUrl(),
            entry.contentHash,
        );
        if (download.kind === "CONTENT_NOT_RETAINED") {
            return { kind: "NOT_RETAINED" };
        }
        if (download.kind !== "OK") {
            return { kind: "UNAVAILABLE" };
        }

        const content = download.value;
        if (
            content.byteLength !== entry.size ||
            (await contentHash(content)) !== entry.contentHash
        ) {
            throw new Error(
                "The restored content does not match its history entry",
            );
        }

        const replica = await this.store.replica(path);
        await this.localVault.writeFile(path, content);
        if (replica?.state === "DELETED") {
            await this.queueRestoreCreate(
                path,
                replica.revision,
                entry,
                content,
            );
        } else {
            await this.captureContent(path, content);
        }
        return { kind: "QUEUED" };
    }

    private async blockedReason(
        path: string,
        entry: RemoteHistoryEntry,
    ): Promise<RestoreBlockedReason | undefined> {
        if (entry.size !== undefined && exceedsSyncContentLimit(entry.size)) {
            return "TOO_LARGE";
        }
        if (await this.store.hasConflict(path)) {
            return "CONFLICT";
        }
        if ((await this.store.findActiveOperation(path)) !== undefined) {
            return "PENDING";
        }

        const replica = await this.store.replica(path);
        const local = await this.localVault.readFile(path);
        if (replica?.entryType !== "FILE") {
            return "UNKNOWN_PATH";
        }
        if (replica.state === "DELETED") {
            return local === undefined ? undefined : "PATH_OCCUPIED";
        }
        if (
            local === undefined ||
            (await contentHash(local)) !== replica.contentHash
        ) {
            return "OUT_OF_SYNC";
        }
        return replica.contentHash === entry.contentHash
            ? "ALREADY_CURRENT"
            : undefined;
    }

    private async queueRestoreCreate(
        path: string,
        deletedRevision: number,
        entry: RemoteHistoryEntry,
        content: ArrayBuffer,
    ): Promise<void> {
        if (entry.contentHash === undefined) {
            throw new Error("A restore requires a content hash");
        }

        const pending: PendingCreate = {
            operationId: `OP-${crypto.randomUUID()}`,
            clientId: await this.store.clientId(),
            type: "CREATE",
            path,
            base: { state: "DELETED", revision: deletedRevision },
            contentHash: entry.contentHash,
            size: content.byteLength,
            artifactId: `artifact-${crypto.randomUUID()}`,
            createdAt: new Date().toISOString(),
            status: "READY",
        };
        await this.store.saveContentOperation(pending, new Blob([content]));
    }

    private requireServerUrl(): string {
        const serverUrl = this.serverUrl();
        if (serverUrl.length === 0) {
            throw new Error("A server URL is required to read file history");
        }
        return serverUrl;
    }
}
