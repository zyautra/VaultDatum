export function isSyncPath(path: string): boolean {
    if (
        path.length === 0 ||
        path.includes("\\") ||
        path.startsWith("/") ||
        path.endsWith("/")
    ) {
        return false;
    }
    if (path === ".obsidian" || path.startsWith(".obsidian/")) {
        return false;
    }

    return path
        .split("/")
        .every(
            (segment) =>
                segment.length > 0 && segment !== "." && segment !== "..",
        );
}
