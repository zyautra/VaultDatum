CREATE TABLE previous_vault (
    vault_id TEXT PRIMARY KEY,
    replaced_at TEXT NOT NULL,
    restored_backup_created_at TEXT NOT NULL
);
