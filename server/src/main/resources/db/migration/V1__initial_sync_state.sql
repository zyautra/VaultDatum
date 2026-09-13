CREATE TABLE vault_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    vault_id TEXT NOT NULL UNIQUE,
    current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0)
);

CREATE TABLE path_state (
    path TEXT PRIMARY KEY,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('FILE', 'DIRECTORY')),
    state TEXT NOT NULL CHECK (state IN ('PRESENT', 'DELETED')),
    latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
    content_hash TEXT,
    size INTEGER CHECK (size IS NULL OR size >= 0),
    last_content_hash TEXT,
    CHECK (state = 'PRESENT' OR (content_hash IS NULL AND size IS NULL)),
    CHECK (entry_type = 'FILE' OR (content_hash IS NULL AND size IS NULL)),
    CHECK (
        entry_type <> 'FILE'
        OR state <> 'PRESENT'
        OR (content_hash IS NOT NULL AND size IS NOT NULL)
    )
);

CREATE TABLE change_journal (
    revision INTEGER PRIMARY KEY CHECK (revision >= 1),
    change_type TEXT NOT NULL CHECK (
        change_type IN ('CREATE', 'MODIFY', 'DELETE', 'RENAME', 'MOVE')
    ),
    operation_id TEXT NOT NULL UNIQUE,
    actor_type TEXT NOT NULL CHECK (
        actor_type IN ('CLIENT', 'SERVER_EXTERNAL', 'SYSTEM')
    ),
    actor_client_id TEXT,
    source_path TEXT,
    destination_path TEXT,
    committed_at TEXT NOT NULL
);

CREATE TABLE change_effect (
    revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    path TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('FILE', 'DIRECTORY')),
    state TEXT NOT NULL CHECK (state IN ('PRESENT', 'DELETED')),
    content_hash TEXT,
    size INTEGER CHECK (size IS NULL OR size >= 0),
    PRIMARY KEY (revision, ordinal),
    FOREIGN KEY (revision) REFERENCES change_journal (revision),
    CHECK (state = 'PRESENT' OR (content_hash IS NULL AND size IS NULL)),
    CHECK (entry_type = 'FILE' OR (content_hash IS NULL AND size IS NULL)),
    CHECK (
        entry_type <> 'FILE'
        OR state <> 'PRESENT'
        OR (content_hash IS NOT NULL AND size IS NOT NULL)
    )
);

CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    actor_client_id TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (
        operation_type IN ('CREATE', 'MODIFY', 'DELETE', 'RENAME', 'MOVE')
    ),
    request_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PREPARED', 'COMMITTED', 'FAILED')),
    staging_reference TEXT,
    recovery_reference TEXT,
    result_revision INTEGER,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (result_revision) REFERENCES change_journal (revision)
);

CREATE TABLE operation_base_condition (
    operation_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    path TEXT NOT NULL,
    expected_state TEXT NOT NULL CHECK (
        expected_state IN ('UNKNOWN', 'PRESENT', 'DELETED')
    ),
    expected_revision INTEGER CHECK (expected_revision >= 1),
    expected_hash TEXT,
    PRIMARY KEY (operation_id, ordinal),
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
    CHECK (
        expected_state = 'UNKNOWN'
        OR expected_revision IS NOT NULL
    ),
    CHECK (
        expected_state <> 'UNKNOWN'
        OR (expected_revision IS NULL AND expected_hash IS NULL)
    )
);

CREATE INDEX change_effect_path_revision_index ON change_effect (path, revision);

CREATE INDEX operation_base_condition_path_index ON operation_base_condition (path);
