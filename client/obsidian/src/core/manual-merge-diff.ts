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
        const server = createFragment(pendingServer, serverLine);
        const local = createFragment(pendingLocal, localLine);
        serverLine += server.lines.length;
        localLine += local.lines.length;
        blocks.push({
            id: `change-${changeId++}`,
            kind: "CHANGE",
            server,
            local,
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
            return (selections.get(block.id) ?? "LOCAL") === "SERVER"
                ? block.server.content
                : block.local.content;
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
            },
        ],
        limited: true,
    };
}

function displayLines(content: string): readonly string[] {
    if (content.length === 0) {
        return [];
    }

    const normalized = content.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    return normalized.endsWith("\n") ? lines.slice(0, -1) : lines;
}
