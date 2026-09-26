import assert from "node:assert/strict";

import {
    composeManualMergeResult,
    createManualMergeDiff,
    manualMergeChangeBlocks,
} from "../src/core/manual-merge-diff";

void (async (): Promise<void> => {
    const server = "title\nserver line\ncommon\n";
    const local = "title\nlocal line\ncommon\n";
    const diff = createManualMergeDiff(server, local);
    const changes = manualMergeChangeBlocks(diff);

    assert.equal(diff.limited, false);
    assert.equal(changes.length, 1);
    assert.deepEqual(
        changes[0]?.server.lines.map((line) => [line.number, line.text]),
        [[2, "server line"]],
    );
    assert.deepEqual(
        changes[0]?.local.lines.map((line) => [line.number, line.text]),
        [[2, "local line"]],
    );
    assert.equal(composeManualMergeResult(diff, new Map()), local);
    assert.equal(
        composeManualMergeResult(
            diff,
            new Map([[changes[0]?.id ?? "", "SERVER"]]),
        ),
        server,
    );

    const insertion = createManualMergeDiff(
        "one\nthree\n",
        "one\ntwo\nthree\n",
    );
    const insertionChange = manualMergeChangeBlocks(insertion)[0];
    assert.deepEqual(
        insertionChange?.server.lines.map((line) => line.text),
        [],
    );
    assert.deepEqual(
        insertionChange?.local.lines.map((line) => line.text),
        ["two"],
    );
    assert.equal(
        composeManualMergeResult(
            insertion,
            new Map([[insertionChange?.id ?? "", "SERVER"]]),
        ),
        "one\nthree\n",
    );

    const separateChanges = createManualMergeDiff(
        "server first\nshared\nserver second\n",
        "local first\nshared\nlocal second\n",
    );
    const separateHunks = manualMergeChangeBlocks(separateChanges);
    assert.equal(separateHunks.length, 2);
    assert.equal(
        composeManualMergeResult(
            separateChanges,
            new Map([[separateHunks[0]?.id ?? "", "SERVER"]]),
        ),
        "server first\nshared\nlocal second\n",
    );
})();
