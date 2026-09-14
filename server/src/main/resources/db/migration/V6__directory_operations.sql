CREATE TABLE operation_directory_create (
    operation_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

CREATE TABLE operation_directory_delete (
    operation_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id)
);

CREATE TABLE operation_directory_path_change (
    operation_id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations (operation_id),
    CHECK (source_path <> destination_path)
);
