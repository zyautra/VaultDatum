export async function contentHash(content: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", content);
    const hexadecimal = Array.from(new Uint8Array(digest), (current) =>
        current.toString(16).padStart(2, "0"),
    ).join("");

    return `sha256:${hexadecimal}`;
}
