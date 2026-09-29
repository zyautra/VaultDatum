CREATE TABLE history_object (
    content_hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL CHECK (size >= 0),
    stored_at TEXT NOT NULL
);

CREATE INDEX history_object_stored_at_index ON history_object (stored_at);
