import assert from "node:assert/strict";

import {
    composeManualMergeResult,
    createManualMergeDiff,
    manualMergeChangeBlocks,
    manualMergeChoiceRows,
} from "../src/core/manual-merge-diff";

void (async (): Promise<void> => {
    const server = "title\nserver line\ncommon\n";
    const local = "title\nlocal line\ncommon\n";
    const diff = createManualMergeDiff(server, local);
    const changes = manualMergeChangeBlocks(diff);
    const rows = manualMergeChoiceRows(diff);

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
    assert.equal(rows.length, 1);
    assert.equal(composeManualMergeResult(diff, new Map()), local);
    assert.equal(
        composeManualMergeResult(
            diff,
            new Map([[rows[0]?.id ?? "", "SERVER"]]),
        ),
        server,
    );

    const insertion = createManualMergeDiff(
        "one\nthree\n",
        "one\ntwo\nthree\n",
    );
    const insertionChange = manualMergeChangeBlocks(insertion)[0];
    const insertionRow = manualMergeChoiceRows(insertion)[0];
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
            new Map([[insertionRow?.id ?? "", "SERVER"]]),
        ),
        "one\nthree\n",
    );

    const separateChanges = createManualMergeDiff(
        "server first\nshared\nserver second\n",
        "local first\nshared\nlocal second\n",
    );
    const separateHunks = manualMergeChangeBlocks(separateChanges);
    const separateRows = manualMergeChoiceRows(separateChanges);
    assert.equal(separateHunks.length, 2);
    assert.equal(
        composeManualMergeResult(
            separateChanges,
            new Map([[separateRows[0]?.id ?? "", "SERVER"]]),
        ),
        "server first\nshared\nlocal second\n",
    );

    const contiguousChange = createManualMergeDiff(
        "server first\nserver second\n",
        "local first\nlocal second\n",
    );
    const contiguousRows = manualMergeChoiceRows(contiguousChange);
    assert.equal(manualMergeChangeBlocks(contiguousChange).length, 1);
    assert.equal(contiguousRows.length, 2);
    assert.equal(
        composeManualMergeResult(
            contiguousChange,
            new Map([[contiguousRows[0]?.id ?? "", "SERVER"]]),
        ),
        "server first\nlocal second\n",
    );
    assert.equal(
        composeManualMergeResult(
            contiguousChange,
            new Map(contiguousRows.map((row) => [row.id, "SERVER"])),
        ),
        "server first\nserver second\n",
    );

    const missingFinalNewline = createManualMergeDiff(
        "server first\nserver second\n",
        "device first",
    );
    const missingFinalNewlineRows = manualMergeChoiceRows(missingFinalNewline);
    assert.equal(missingFinalNewlineRows.length, 2);
    assert.equal(
        composeManualMergeResult(
            missingFinalNewline,
            new Map([[missingFinalNewlineRows[1]?.id ?? "", "SERVER"]]),
        ),
        "device first\nserver second\n",
    );
    assert.equal(
        composeManualMergeResult(missingFinalNewline, new Map()),
        "device first",
    );

    const missingFinalCrLf = createManualMergeDiff(
        "server first\r\nserver second\r\n",
        "device first",
    );
    const missingFinalCrLfRows = manualMergeChoiceRows(missingFinalCrLf);
    assert.equal(
        composeManualMergeResult(
            missingFinalCrLf,
            new Map([[missingFinalCrLfRows[1]?.id ?? "", "SERVER"]]),
        ),
        "device first\r\nserver second\r\n",
    );
})();
