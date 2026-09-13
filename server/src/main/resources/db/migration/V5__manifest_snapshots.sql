CREATE TABLE manifest (
    manifest_id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0),
    expires_at TEXT NOT NULL
);

CREATE TABLE manifest_entry (
    manifest_id TEXT NOT NULL,
    path TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('FILE', 'DIRECTORY')),
    state TEXT NOT NULL CHECK (state IN ('PRESENT', 'DELETED')),
    latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
    content_hash TEXT,
    size INTEGER CHECK (size IS NULL OR size >= 0),
    PRIMARY KEY (manifest_id, path),
    FOREIGN KEY (manifest_id) REFERENCES manifest (manifest_id) ON DELETE CASCADE,
    CHECK (state = 'PRESENT' OR (content_hash IS NULL AND size IS NULL)),
    CHECK (entry_type = 'FILE' OR (content_hash IS NULL AND size IS NULL)),
    CHECK (
        entry_type <> 'FILE'
        OR state <> 'PRESENT'
        OR (content_hash IS NOT NULL AND size IS NOT NULL)
    )
);

CREATE INDEX manifest_expiry_index ON manifest (expires_at);
