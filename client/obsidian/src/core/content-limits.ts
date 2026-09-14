export const MAX_SYNC_CONTENT_BYTES = 8 * 1024 * 1024;

export function exceedsSyncContentLimit(size: number): boolean {
    return (
        !Number.isSafeInteger(size) || size < 0 || size > MAX_SYNC_CONTENT_BYTES
    );
}
