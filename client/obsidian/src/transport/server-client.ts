import { requestUrl } from "obsidian";

import type { components } from "./generated/protocol";
import type {
    PendingCreate,
    PendingDelete,
    PendingModify,
    PendingRename,
} from "../storage/client-store";

type OperationResult = components["schemas"]["OperationResult"];

export interface RemoteVaultInfo {
    readonly vaultId: string;
    readonly currentRevision: number;
    readonly oldestRetainedRevision: number;
    readonly protocolVersion: 1;
    readonly hashAlgorithm: "SHA-256";
}

export interface RemoteChangePage {
    readonly vaultId: string;
    readonly fromExclusive: number;
    readonly toInclusive: number;
    readonly currentRevision: number;
    readonly hasMore: boolean;
    readonly changes: readonly RemoteChange[];
}

export interface RemoteChange {
    readonly revision: number;
    readonly type: "CREATE" | "MODIFY" | "DELETE" | "RENAME" | "MOVE";
    readonly operationId: string;
    readonly actor: RemoteActor;
    readonly effects: readonly RemoteChangeEffect[];
}

export interface RemoteActor {
    readonly type: "CLIENT" | "SERVER_EXTERNAL" | "SYSTEM";
    readonly clientId?: string;
}

export interface RemoteChangeEffect {
    readonly path: string;
    readonly entryType: "FILE" | "DIRECTORY";
    readonly state: "PRESENT" | "DELETED";
    readonly contentHash?: string;
    readonly size?: number;
}

export interface RemoteManifestCreated {
    readonly manifestId: string;
    readonly vaultId: string;
    readonly snapshotRevision: number;
    readonly expiresAt: string;
}

export interface RemoteManifest {
    readonly manifestId: string;
    readonly vaultId: string;
    readonly snapshotRevision: number;
    readonly expiresAt: string;
    readonly entries: readonly RemoteManifestEntry[];
}

export interface RemoteManifestEntry {
    readonly path: string;
    readonly entryType: "FILE" | "DIRECTORY";
    readonly state: "PRESENT" | "DELETED";
    readonly revision: number;
    readonly contentHash?: string;
    readonly size?: number;
}

export type SubmitOperationResult =
    | { readonly kind: "COMMITTED"; readonly result: OperationResult }
    | { readonly kind: "REJECTED"; readonly code: string }
    | { readonly kind: "UNAVAILABLE" };

export type ReadResult<T> =
    | { readonly kind: "OK"; readonly value: T }
    | { readonly kind: "UNAVAILABLE" }
    | { readonly kind: "STATE_CHANGED" }
    | { readonly kind: "MANIFEST_EXPIRED" }
    | { readonly kind: "HISTORY_NOT_AVAILABLE" };

export interface ContentTransport {
    downloadContent(
        serverUrl: string,
        path: string,
        revision: number,
        contentHash: string,
    ): Promise<ReadResult<ArrayBuffer>>;
}

export interface SyncTransport extends ContentTransport {
    readVault(serverUrl: string): Promise<ReadResult<RemoteVaultInfo>>;
    createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>>;
    readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>>;
    listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>>;
    submitCreate(
        serverUrl: string,
        pending: PendingCreate,
        content: Blob,
    ): Promise<SubmitOperationResult>;
    submitModify(
        serverUrl: string,
        pending: PendingModify,
        content: Blob,
    ): Promise<SubmitOperationResult>;
    submitDelete(
        serverUrl: string,
        pending: PendingDelete,
    ): Promise<SubmitOperationResult>;
    submitRename(
        serverUrl: string,
        pending: PendingRename,
    ): Promise<SubmitOperationResult>;
}

export class ServerClient implements SyncTransport {
    public async readVault(
        serverUrl: string,
    ): Promise<ReadResult<RemoteVaultInfo>> {
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/vault`,
            throw: false,
        });

        if (response.status === 200) {
            const vault = vaultInfo(response.text);

            if (vault !== undefined) {
                return { kind: "OK", value: vault };
            }

            throw new Error("Server returned invalid Vault metadata");
        }

        return readFailure(response.status, response.text);
    }

    public async createManifest(
        serverUrl: string,
    ): Promise<ReadResult<RemoteManifestCreated>> {
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/manifests`,
            method: "POST",
            throw: false,
        });

        if (response.status === 201) {
            const created = manifestCreated(response.text);
            if (created !== undefined) {
                return { kind: "OK", value: created };
            }
            throw new Error("Server returned an invalid manifest response");
        }

        return readFailure(response.status, response.text);
    }

    public async readManifest(
        serverUrl: string,
        manifestId: string,
    ): Promise<ReadResult<RemoteManifest>> {
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/manifests/${encodeURIComponent(manifestId)}`,
            throw: false,
        });

        if (response.status === 200) {
            const manifest = manifestSnapshot(response.text);
            if (manifest !== undefined && manifest.manifestId === manifestId) {
                return { kind: "OK", value: manifest };
            }
            throw new Error("Server returned an invalid manifest snapshot");
        }

        return readFailure(response.status, response.text);
    }

    public async listChanges(
        serverUrl: string,
        after: number,
        limit: number,
    ): Promise<ReadResult<RemoteChangePage>> {
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/changes?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`,
            throw: false,
        });

        if (response.status === 200) {
            const page = changePage(response.text);

            if (page !== undefined && page.fromExclusive === after) {
                return { kind: "OK", value: page };
            }

            throw new Error("Server returned an invalid change page");
        }

        return readFailure(response.status, response.text);
    }

    public async downloadContent(
        serverUrl: string,
        path: string,
        revision: number,
        contentHash: string,
    ): Promise<ReadResult<ArrayBuffer>> {
        const query = new URLSearchParams({
            path,
            revision: revision.toString(),
            hash: contentHash,
        });
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/content?${query.toString()}`,
            throw: false,
        });

        if (response.status === 200) {
            const responseHash = header(
                response.headers,
                "x-vaultdatum-content-hash",
            );

            if (responseHash === contentHash) {
                return { kind: "OK", value: response.arrayBuffer };
            }

            throw new Error(
                "Server returned content with an unexpected hash header",
            );
        }

        return readFailure(response.status, response.text);
    }

    public async submitCreate(
        serverUrl: string,
        pending: PendingCreate,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        return this.submitContentOperation(serverUrl, pending, content);
    }

    public async submitModify(
        serverUrl: string,
        pending: PendingModify,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        return this.submitContentOperation(serverUrl, pending, content);
    }

    public async submitDelete(
        serverUrl: string,
        pending: PendingDelete,
    ): Promise<SubmitOperationResult> {
        const metadata = {
            operationId: pending.operationId,
            clientId: pending.clientId,
            type: "DELETE" as const,
            path: pending.path,
            base: [
                {
                    path: pending.path,
                    state: "PRESENT" as const,
                    revision: pending.baseRevision,
                    contentHash: pending.baseContentHash,
                },
            ],
        } satisfies components["schemas"]["DeleteOperationRequest"];
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/operations`,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify(metadata),
            throw: false,
        });

        return operationResponse(
            response.status,
            response.text,
            pending.operationId,
        );
    }

    public async submitRename(
        serverUrl: string,
        pending: PendingRename,
    ): Promise<SubmitOperationResult> {
        const metadata = {
            operationId: pending.operationId,
            clientId: pending.clientId,
            type: "RENAME" as const,
            sourcePath: pending.path,
            destinationPath: pending.destinationPath,
            base: [
                {
                    path: pending.path,
                    state: "PRESENT" as const,
                    revision: pending.baseRevision,
                    contentHash: pending.baseContentHash,
                },
                { path: pending.destinationPath, state: "UNKNOWN" as const },
            ],
        } satisfies components["schemas"]["RenameOperationRequest"];
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/operations`,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify(metadata),
            throw: false,
        });

        return operationResponse(
            response.status,
            response.text,
            pending.operationId,
        );
    }

    private async submitContentOperation(
        serverUrl: string,
        pending: PendingCreate | PendingModify,
        content: Blob,
    ): Promise<SubmitOperationResult> {
        const metadata = contentMetadata(pending);
        const boundary = `VaultDatum-${crypto.randomUUID()}`;
        const response = await requestUrl({
            url: `${serverUrl}/api/v1/operations`,
            method: "POST",
            contentType: `multipart/form-data; boundary=${boundary}`,
            body: await multipartBody(
                boundary,
                JSON.stringify(metadata),
                content,
            ),
            throw: false,
        });

        return operationResponse(
            response.status,
            response.text,
            pending.operationId,
        );
    }
}

function contentMetadata(
    pending: PendingCreate | PendingModify,
): components["schemas"]["ContentOperationRequest"] {
    if (pending.type === "CREATE") {
        return {
            operationId: pending.operationId,
            clientId: pending.clientId,
            type: "CREATE",
            path: pending.path,
            base:
                pending.base.state === "UNKNOWN"
                    ? [{ path: pending.path, state: "UNKNOWN" }]
                    : [
                          {
                              path: pending.path,
                              state: "DELETED",
                              revision: pending.base.revision,
                          },
                      ],
            content: {
                contentHash: pending.contentHash,
                size: pending.size,
            },
        } satisfies components["schemas"]["CreateOperationRequest"];
    }

    return {
        operationId: pending.operationId,
        clientId: pending.clientId,
        type: "MODIFY",
        path: pending.path,
        base: [
            {
                path: pending.path,
                state: "PRESENT",
                revision: pending.baseRevision,
                contentHash: pending.baseContentHash,
            },
        ],
        content: {
            contentHash: pending.contentHash,
            size: pending.size,
        },
    } satisfies components["schemas"]["ModifyOperationRequest"];
}

function operationResponse(
    status: number,
    content: string,
    operationId: string,
): SubmitOperationResult {
    if (status === 200) {
        const result = operationResult(content);

        if (result !== undefined && result.operationId === operationId) {
            return { kind: "COMMITTED", result };
        }

        throw new Error("Server returned an invalid operation result");
    }
    if (status === 503) {
        return { kind: "UNAVAILABLE" };
    }

    return {
        kind: "REJECTED",
        code: errorCode(content) ?? `HTTP_${status}`,
    };
}

async function multipartBody(
    boundary: string,
    metadata: string,
    content: Blob,
): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="operation"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="content.bin"\r\n` +
            "Content-Type: application/octet-stream\r\n\r\n",
    );
    const bytes = new Uint8Array(await content.arrayBuffer());
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(prefix.length + bytes.length + suffix.length);

    body.set(prefix);
    body.set(bytes, prefix.length);
    body.set(suffix, prefix.length + bytes.length);
    return body.buffer;
}

function readFailure(status: number, content: string): ReadResult<never> {
    if (status === 503) {
        return { kind: "UNAVAILABLE" };
    }

    const code = errorCode(content);
    if (code === "STATE_CHANGED") {
        return { kind: "STATE_CHANGED" };
    }
    if (code === "MANIFEST_EXPIRED") {
        return { kind: "MANIFEST_EXPIRED" };
    }
    if (code === "HISTORY_NOT_AVAILABLE") {
        return { kind: "HISTORY_NOT_AVAILABLE" };
    }

    throw new Error(`Server rejected a read request with HTTP ${status}`);
}

function vaultInfo(content: string): RemoteVaultInfo | undefined {
    const parsed = parseJson(content);

    if (
        !isRecord(parsed) ||
        typeof parsed.vaultId !== "string" ||
        !nonNegativeInteger(parsed.currentRevision) ||
        !nonNegativeInteger(parsed.oldestRetainedRevision) ||
        parsed.protocolVersion !== 1 ||
        parsed.hashAlgorithm !== "SHA-256"
    ) {
        return undefined;
    }

    return {
        vaultId: parsed.vaultId,
        currentRevision: parsed.currentRevision,
        oldestRetainedRevision: parsed.oldestRetainedRevision,
        protocolVersion: 1,
        hashAlgorithm: "SHA-256",
    };
}

function changePage(content: string): RemoteChangePage | undefined {
    const parsed = parseJson(content);

    if (
        !isRecord(parsed) ||
        typeof parsed.vaultId !== "string" ||
        !nonNegativeInteger(parsed.fromExclusive) ||
        !nonNegativeInteger(parsed.toInclusive) ||
        !nonNegativeInteger(parsed.currentRevision) ||
        typeof parsed.hasMore !== "boolean" ||
        !Array.isArray(parsed.changes)
    ) {
        return undefined;
    }

    const changes = parsed.changes.map(change);
    if (changes.some((entry) => entry === undefined)) {
        return undefined;
    }

    return {
        vaultId: parsed.vaultId,
        fromExclusive: parsed.fromExclusive,
        toInclusive: parsed.toInclusive,
        currentRevision: parsed.currentRevision,
        hasMore: parsed.hasMore,
        changes: changes as RemoteChange[],
    };
}

function manifestCreated(content: string): RemoteManifestCreated | undefined {
    const parsed = parseJson(content);
    if (
        !isRecord(parsed) ||
        typeof parsed.manifestId !== "string" ||
        parsed.manifestId.length === 0 ||
        typeof parsed.vaultId !== "string" ||
        !nonNegativeInteger(parsed.snapshotRevision) ||
        !dateTime(parsed.expiresAt)
    ) {
        return undefined;
    }

    return {
        manifestId: parsed.manifestId,
        vaultId: parsed.vaultId,
        snapshotRevision: parsed.snapshotRevision,
        expiresAt: parsed.expiresAt,
    };
}

function manifestSnapshot(content: string): RemoteManifest | undefined {
    const parsed = parseJson(content);
    if (
        !isRecord(parsed) ||
        typeof parsed.manifestId !== "string" ||
        parsed.manifestId.length === 0 ||
        typeof parsed.vaultId !== "string" ||
        !nonNegativeInteger(parsed.snapshotRevision) ||
        !dateTime(parsed.expiresAt) ||
        !Array.isArray(parsed.entries)
    ) {
        return undefined;
    }

    const entries = parsed.entries.map(manifestEntry);
    if (entries.some((entry) => entry === undefined)) {
        return undefined;
    }
    return {
        manifestId: parsed.manifestId,
        vaultId: parsed.vaultId,
        snapshotRevision: parsed.snapshotRevision,
        expiresAt: parsed.expiresAt,
        entries: entries as RemoteManifestEntry[],
    };
}

function manifestEntry(value: unknown): RemoteManifestEntry | undefined {
    if (
        !isRecord(value) ||
        typeof value.path !== "string" ||
        !entryType(value.entryType) ||
        !replicaState(value.state) ||
        !positiveInteger(value.revision)
    ) {
        return undefined;
    }
    if (value.state === "DELETED") {
        return {
            path: value.path,
            entryType: value.entryType,
            state: "DELETED",
            revision: value.revision,
        };
    }
    if (
        value.entryType === "FILE" &&
        isContentHash(value.contentHash) &&
        nonNegativeInteger(value.size)
    ) {
        return {
            path: value.path,
            entryType: "FILE",
            state: "PRESENT",
            revision: value.revision,
            contentHash: value.contentHash,
            size: value.size,
        };
    }
    if (value.entryType === "DIRECTORY") {
        return {
            path: value.path,
            entryType: "DIRECTORY",
            state: "PRESENT",
            revision: value.revision,
        };
    }

    return undefined;
}

function change(value: unknown): RemoteChange | undefined {
    if (
        !isRecord(value) ||
        !positiveInteger(value.revision) ||
        !changeType(value.type) ||
        typeof value.operationId !== "string" ||
        value.operationId.length === 0 ||
        !Array.isArray(value.effects)
    ) {
        return undefined;
    }

    const actor = changeActor(value.actor);
    const effects = value.effects.map(changeEffect);
    if (
        actor === undefined ||
        effects.length === 0 ||
        effects.some((entry) => entry === undefined)
    ) {
        return undefined;
    }

    return {
        revision: value.revision,
        type: value.type,
        operationId: value.operationId,
        actor,
        effects: effects as RemoteChangeEffect[],
    };
}

function changeActor(value: unknown): RemoteActor | undefined {
    if (!isRecord(value) || typeof value.type !== "string") {
        return undefined;
    }
    if (value.type === "CLIENT" && typeof value.clientId === "string") {
        return { type: "CLIENT", clientId: value.clientId };
    }
    if (value.type === "SERVER_EXTERNAL" || value.type === "SYSTEM") {
        return { type: value.type };
    }

    return undefined;
}

function changeEffect(value: unknown): RemoteChangeEffect | undefined {
    if (
        !isRecord(value) ||
        typeof value.path !== "string" ||
        !entryType(value.entryType) ||
        !replicaState(value.state)
    ) {
        return undefined;
    }
    if (value.state === "DELETED") {
        return {
            path: value.path,
            entryType: value.entryType,
            state: "DELETED",
        };
    }
    if (
        value.entryType === "FILE" &&
        isContentHash(value.contentHash) &&
        nonNegativeInteger(value.size)
    ) {
        return {
            path: value.path,
            entryType: "FILE",
            state: "PRESENT",
            contentHash: value.contentHash,
            size: value.size,
        };
    }
    if (value.entryType === "DIRECTORY") {
        return {
            path: value.path,
            entryType: "DIRECTORY",
            state: "PRESENT",
        };
    }

    return undefined;
}

function operationResult(content: string): OperationResult | undefined {
    const parsed = parseJson(content);

    if (
        !isRecord(parsed) ||
        typeof parsed.operationId !== "string" ||
        parsed.status !== "COMMITTED" ||
        !positiveInteger(parsed.resultRevision) ||
        typeof parsed.replayed !== "boolean"
    ) {
        return undefined;
    }

    return {
        operationId: parsed.operationId,
        status: "COMMITTED",
        resultRevision: parsed.resultRevision,
        replayed: parsed.replayed,
    };
}

function errorCode(content: string): string | undefined {
    const parsed = parseJson(content);

    if (
        !isRecord(parsed) ||
        !isRecord(parsed.error) ||
        typeof parsed.error.code !== "string"
    ) {
        return undefined;
    }

    return parsed.error.code;
}

function header(
    headers: Record<string, string>,
    name: string,
): string | undefined {
    return Object.entries(headers).find(
        ([key]) => key.toLowerCase() === name,
    )?.[1];
}

function parseJson(content: string): unknown {
    try {
        return JSON.parse(content) as unknown;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
}

function positiveInteger(value: unknown): value is number {
    return nonNegativeInteger(value) && value > 0;
}

function dateTime(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        !Number.isNaN(Date.parse(value))
    );
}

function isContentHash(value: unknown): value is string {
    return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function changeType(value: unknown): value is RemoteChange["type"] {
    return (
        value === "CREATE" ||
        value === "MODIFY" ||
        value === "DELETE" ||
        value === "RENAME" ||
        value === "MOVE"
    );
}

function entryType(value: unknown): value is RemoteChangeEffect["entryType"] {
    return value === "FILE" || value === "DIRECTORY";
}

function replicaState(value: unknown): value is RemoteChangeEffect["state"] {
    return value === "PRESENT" || value === "DELETED";
}
