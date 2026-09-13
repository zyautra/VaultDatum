CREATE TABLE operation_modify (
    operation_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

CREATE TABLE operation_delete (
    operation_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);
