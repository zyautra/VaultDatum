package io.vaultdatum.server.sync;

/**
 * Why a server Backup was refreshed.
 */
public enum BackupTrigger {
    SCHEDULED,
    PRE_MIGRATION
}
