import { diffLines } from "diff";

const MAX_LINE_DIFF_EDIT_LENGTH = 10_000;

export type ManualMergeSource = "SERVER" | "LOCAL";

export interface ManualMergeLine {
    readonly number: number;
    readonly text: string;
}

interface ManualMergeFragment {
    readonly content: string;
    readonly lines: readonly ManualMergeLine[];
}

export interface ManualMergeChoiceRow {
    readonly id: string;
    readonly server: ManualMergeFragment;
    readonly local: ManualMergeFragment;
}

interface ManualMergeEqualBlock {
    readonly kind: "EQUAL";
    readonly server: ManualMergeFragment;
    readonly local: ManualMergeFragment;
}

export interface ManualMergeChangeBlock {
    readonly id: string;
    readonly kind: "CHANGE";
    readonly server: ManualMergeFragment;
    readonly local: ManualMergeFragment;
    readonly rows: readonly ManualMergeChoiceRow[];
}

export type ManualMergeDiffBlock =
    ManualMergeEqualBlock | ManualMergeChangeBlock;

export interface ManualMergeDiff {
    readonly blocks: readonly ManualMergeDiffBlock[];
    readonly limited: boolean;
}

export function createManualMergeDiff(
    serverContent: string,
    localContent: string,
): ManualMergeDiff {
    const changes = diffLines(serverContent, localContent, {
        maxEditLength: MAX_LINE_DIFF_EDIT_LENGTH,
    });
    if (changes === undefined) {
        return createSingleChangeDiff(serverContent, localContent);
    }

    const blocks: ManualMergeDiffBlock[] = [];
    let changeId = 0;
    let localLine = 1;
    let serverLine = 1;
    let pendingLocal = "";
    let pendingServer = "";

    const appendChange = (): void => {
        if (pendingServer.length === 0 && pendingLocal.length === 0) {
            return;
        }
        const id = `change-${changeId++}`;
        const server = createFragment(pendingServer, serverLine);
        const local = createFragment(pendingLocal, localLine);
        serverLine += server.lines.length;
        localLine += local.lines.length;
        blocks.push({
            id,
            kind: "CHANGE",
            server,
            local,
            rows: createChoiceRows(
                id,
                pendingServer,
                pendingLocal,
                serverLine - server.lines.length,
                localLine - local.lines.length,
            ),
        });
        pendingServer = "";
        pendingLocal = "";
    };

    for (const change of changes) {
        if (change.removed) {
            pendingServer += change.value;
            continue;
        }
        if (change.added) {
            pendingLocal += change.value;
            continue;
        }

        appendChange();
        const server = createFragment(change.value, serverLine);
        const local = createFragment(change.value, localLine);
        serverLine += server.lines.length;
        localLine += local.lines.length;
        blocks.push({ kind: "EQUAL", server, local });
    }
    appendChange();

    return { blocks, limited: false };
}

export function composeManualMergeResult(
    diff: ManualMergeDiff,
    selections: ReadonlyMap<string, ManualMergeSource>,
): string {
    return diff.blocks
        .map((block) => {
            if (block.kind === "EQUAL") {
                return block.local.content;
            }
            return block.rows
                .map((row) =>
                    (selections.get(row.id) ?? "LOCAL") === "SERVER"
                        ? row.server.content
                        : row.local.content,
                )
                .join("");
        })
        .join("");
}

export function manualMergeChangeBlocks(
    diff: ManualMergeDiff,
): readonly ManualMergeChangeBlock[] {
    return diff.blocks.filter(
        (block): block is ManualMergeChangeBlock => block.kind === "CHANGE",
    );
}

export function manualMergeChoiceRows(
    diff: ManualMergeDiff,
): readonly ManualMergeChoiceRow[] {
    return manualMergeChangeBlocks(diff).flatMap((block) => block.rows);
}

function createFragment(
    content: string,
    firstLineNumber: number,
): ManualMergeFragment {
    return {
        content,
        lines: displayLines(content).map((text, index) => ({
            number: firstLineNumber + index,
            text,
        })),
    };
}

function createSingleChangeDiff(
    serverContent: string,
    localContent: string,
): ManualMergeDiff {
    return {
        blocks: [
            {
                id: "change-0",
                kind: "CHANGE",
                server: createFragment(serverContent, 1),
                local: createFragment(localContent, 1),
                rows: [
                    {
                        id: "change-0-line-0",
                        server: createFragment(serverContent, 1),
                        local: createFragment(localContent, 1),
                    },
                ],
            },
        ],
        limited: true,
    };
}

function createChoiceRows(
    changeId: string,
    serverContent: string,
    localContent: string,
    firstServerLine: number,
    firstLocalLine: number,
): readonly ManualMergeChoiceRow[] {
    const serverLines = lineFragments(serverContent);
    const localLines = lineFragments(localContent);
    const rows: ManualMergeChoiceRow[] = [];
    let serverLine = firstServerLine;
    let localLine = firstLocalLine;
    const rowCount = Math.max(serverLines.length, localLines.length);
    for (let index = 0; index < rowCount; index += 1) {
        const serverContentForRow = serverLines[index] ?? "";
        const localContentForRow = localLines[index] ?? "";
        const server = createFragment(serverContentForRow, serverLine);
        const local = createFragment(localContentForRow, localLine);
        serverLine += server.lines.length;
        localLine += local.lines.length;
        rows.push({
            id: `${changeId}-line-${index}`,
            server,
            local,
        });
    }
    return rows;
}

function displayLines(content: string): readonly string[] {
    if (content.length === 0) {
        return [];
    }

    const normalized = content.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    return normalized.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function lineFragments(content: string): readonly string[] {
    return content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
}
