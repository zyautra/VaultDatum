import { requestUrl } from "obsidian";

import type { components } from "./generated/protocol";
import type { PendingCreate } from "../storage/client-store";

type OperationResult = components["schemas"]["OperationResult"];

export type SubmitCreateResult =
    | { readonly kind: "COMMITTED"; readonly result: OperationResult }
    | { readonly kind: "REJECTED"; readonly code: string }
    | { readonly kind: "UNAVAILABLE" };

export class ServerClient {
    public async submitCreate(
        serverUrl: string,
        pending: PendingCreate,
        content: Blob,
    ): Promise<SubmitCreateResult> {
        const metadata = {
            operationId: pending.operationId,
            clientId: pending.clientId,
            type: "CREATE" as const,
            path: pending.path,
            base: [{ path: pending.path, state: "UNKNOWN" as const }],
            content: {
                contentHash: pending.contentHash,
                size: pending.size,
            },
        } satisfies components["schemas"]["CreateOperationRequest"];
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

        if (response.status === 200) {
            const result = operationResult(response.text);

            if (
                result !== undefined &&
                result.operationId === pending.operationId
            ) {
                return { kind: "COMMITTED", result };
            }

            throw new Error("Server returned an invalid operation result");
        }
        if (response.status === 503) {
            return { kind: "UNAVAILABLE" };
        }

        return {
            kind: "REJECTED",
            code: errorCode(response.text) ?? `HTTP_${response.status}`,
        };
    }
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

function operationResult(content: string): OperationResult | undefined {
    const parsed = parseJson(content);

    if (
        !isRecord(parsed) ||
        typeof parsed.operationId !== "string" ||
        parsed.status !== "COMMITTED" ||
        typeof parsed.resultRevision !== "number" ||
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
