// Node replacement for the parts of the Obsidian API the sync core uses.
export interface RequestUrlParam {
    url: string;
    method?: string;
    contentType?: string;
    body?: string | ArrayBuffer;
    headers?: Record<string, string>;
    throw?: boolean;
}

export interface RequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
    arrayBuffer: ArrayBuffer;
    json: unknown;
}

export async function requestUrl(
    param: RequestUrlParam,
): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = { ...(param.headers ?? {}) };
    if (param.contentType !== undefined) {
        headers["Content-Type"] = param.contentType;
    }
    const response = await fetch(param.url, {
        method: param.method ?? "GET",
        headers,
        body: param.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    if (param.throw !== false && response.status >= 400) {
        throw new Error(`HTTP ${response.status}`);
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return {
        status: response.status,
        headers: responseHeaders,
        text,
        arrayBuffer,
        json,
    };
}
