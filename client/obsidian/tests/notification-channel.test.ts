import assert from "node:assert/strict";

import {
    notificationProtocols,
    notificationUrl,
    revisionAdvancedNotification,
} from "../src/sync/notification-channel";

assert.deepEqual(notificationProtocols(undefined), undefined);
assert.deepEqual(
    notificationProtocols({
        ticket: "QWERTYuiopASDFghjklz12",
        expiresAt: "2026-09-27T01:00:00.000Z",
    }),
    ["vaultdatum.v1", "vaultdatum.ticket.QWERTYuiopASDFghjklz12"],
);

assert.deepEqual(
    revisionAdvancedNotification(
        '{"type":"REVISION_ADVANCED","currentRevision":42}',
    ),
    { type: "REVISION_ADVANCED", currentRevision: 42 },
);
assert.equal(revisionAdvancedNotification("not json"), undefined);
assert.equal(
    revisionAdvancedNotification(
        '{"type":"REVISION_ADVANCED","currentRevision":0}',
    ),
    undefined,
);
assert.equal(
    revisionAdvancedNotification(
        '{"type":"UNRECOGNIZED","currentRevision":42}',
    ),
    undefined,
);
assert.equal(
    revisionAdvancedNotification({ type: "REVISION_ADVANCED" }),
    undefined,
);

assert.equal(
    notificationUrl("http://vaultdatum.test"),
    "ws://vaultdatum.test/api/v1/notifications",
);
assert.equal(
    notificationUrl("https://vaultdatum.test/base/"),
    "wss://vaultdatum.test/base/api/v1/notifications",
);
assert.equal(notificationUrl(""), undefined);
assert.equal(notificationUrl("ftp://vaultdatum.test"), undefined);
