CREATE TABLE operation_create (
    operation_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);
