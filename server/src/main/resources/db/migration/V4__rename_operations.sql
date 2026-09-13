CREATE TABLE operation_rename (
    operation_id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
    CHECK (source_path <> destination_path)
);
