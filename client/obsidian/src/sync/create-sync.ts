import { contentHash } from "../core/content-hash";
import { isSyncPath } from "../core/sync-path";
import { ClientStore, type PendingCreate } from "../storage/client-store";
import { ServerClient } from "../transport/server-client";

export interface SyncSummary {
    readonly committed: number;
    readonly conflicted: number;
    readonly offline: boolean;
}

export class CreateSync {
    private activeSync: Promise<SyncSummary> | undefined;

    public constructor(
        private readonly store: ClientStore,
        private readonly serverClient: ServerClient,
        private readonly serverUrl: () => string,
    ) {}

    public async captureCreate(
        path: string,
        content: ArrayBuffer,
    ): Promise<PendingCreate | undefined> {
        if (!isSyncPath(path)) {
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
            contentHash: await contentHash(content),
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
            return { committed: 0, conflicted: 0, offline: true };
        }

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
                await this.store.removeCommitted(
                    pending.operationId,
                    pending.artifactId,
                );
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
