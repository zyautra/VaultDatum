import {
    type ClientSyncActivity,
    type SyncTrackingResetEligibility,
} from "../storage/client-store";
import { type SyncStatus } from "../sync/sync-scheduler";
import { type RemoteVaultInfo } from "../transport/server-client";

export type ConnectionCheck =
    | { readonly kind: "INVALID_URL"; readonly message: string }
    | {
          readonly kind: "AUTHENTICATION_REQUIRED";
          readonly serverUrl: string;
          readonly message: string;
      }
    | {
          readonly kind: "UNAVAILABLE" | "UNEXPECTED";
          readonly serverUrl: string;
          readonly message: string;
      }
    | {
          readonly kind: "CONNECTED";
          readonly serverUrl: string;
          readonly vault: RemoteVaultInfo;
          readonly matchesCurrentVault: boolean;
      };

export interface SyncOverview {
    readonly status: SyncStatus;
    readonly activity: ClientSyncActivity;
    readonly resetEligibility: SyncTrackingResetEligibility;
    readonly serverUrl: string;
    readonly vaultId?: string;
    readonly connectionCheck?: ConnectionCheck;
}

export type OverviewAction =
    | "CONNECT"
    | "UPDATE_TOKEN"
    | "REVIEW_CONNECTION"
    | "RECONNECT_RESTORED"
    | "RETRY"
    | "RESUME"
    | "REVIEW_CONFLICTS"
    | "SYNC";

export function connectionCheckDescription(result: ConnectionCheck): string {
    if (result.kind === "CONNECTED") {
        if (!result.matchesCurrentVault) {
            return "This Server belongs to a different Vault. Existing sync tracking was not changed.";
        }
        return `Connection successful. Vault ID: ${result.vault.vaultId}.`;
    }
    return result.message;
}

export function formatLastSuccessfulSync(
    timestamp: string | undefined,
): string {
    if (timestamp === undefined || !Number.isFinite(Date.parse(timestamp))) {
        return "No successful sync recorded yet.";
    }

    const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
    const minutes = Math.floor(elapsed / 60_000);
    const relative =
        minutes === 0
            ? "Just now"
            : minutes === 1
              ? "1 minute ago"
              : minutes < 60
                ? `${minutes} minutes ago`
                : `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? "" : "s"} ago`;
    return `${relative} (${new Date(timestamp).toLocaleString()}).`;
}

export function primaryOverviewAction(
    status: SyncStatus,
): OverviewAction | undefined {
    if (status.kind === "SETUP_REQUIRED") {
        return "CONNECT";
    }
    if (status.kind === "AUTHENTICATION_REQUIRED") {
        return "UPDATE_TOKEN";
    }
    if (status.kind === "FIRST_SYNC" || status.kind === "SYNCING") {
        return undefined;
    }
    if (status.kind === "PAUSED") {
        return "RESUME";
    }
    if (status.kind === "OFFLINE") {
        return "RETRY";
    }
    if (status.kind === "ERROR") {
        if (status.summary?.vaultRestored === true) {
            return "RECONNECT_RESTORED";
        }
        return status.summary?.vaultMismatch === true
            ? "REVIEW_CONNECTION"
            : "RETRY";
    }
    if (status.kind === "CONFLICT") {
        return "REVIEW_CONFLICTS";
    }
    return "SYNC";
}

export function primaryOverviewActionLabel(action: OverviewAction): string {
    if (action === "CONNECT") {
        return "Connect server";
    }
    if (action === "UPDATE_TOKEN") {
        return "Update access token";
    }
    if (action === "REVIEW_CONNECTION") {
        return "Review connection";
    }
    if (action === "RECONNECT_RESTORED") {
        return "Reconnect to restored Vault";
    }
    if (action === "RESUME") {
        return "Resume sync";
    }
    if (action === "RETRY") {
        return "Retry now";
    }
    if (action === "REVIEW_CONFLICTS") {
        return "Review conflicts";
    }
    return "Sync now";
}

export function connectionOverviewDescription(overview: SyncOverview): string {
    if (overview.serverUrl.length === 0) {
        return "Not configured.";
    }
    if (overview.status.kind === "OFFLINE") {
        return "Saved — server unavailable. Retrying automatically.";
    }
    if (overview.status.kind === "AUTHENTICATION_REQUIRED") {
        return "Saved — update this Vault's access token to continue.";
    }
    if (overview.status.kind === "ERROR") {
        if (overview.status.summary?.vaultRestored === true) {
            return "Saved — the server Vault was restored. Reconnect to continue.";
        }
        return overview.status.summary?.vaultMismatch === true
            ? "Saved — this server belongs to a different Vault."
            : "Saved — the last server check did not complete.";
    }
    if (
        overview.status.kind === "FIRST_SYNC" ||
        overview.status.kind === "SYNCING"
    ) {
        return "Checking server state…";
    }
    if (overview.status.kind === "PAUSED") {
        return overview.connectionCheck?.kind === "CONNECTED"
            ? "Connected — synchronization is paused."
            : "Saved — synchronization is paused before the next check.";
    }
    if (overview.connectionCheck?.kind === "CONNECTED") {
        return "Connected.";
    }
    if (overview.connectionCheck?.kind === "UNAVAILABLE") {
        return "Saved — server unavailable.";
    }
    if (overview.connectionCheck?.kind === "AUTHENTICATION_REQUIRED") {
        return "Saved — Vault access token required.";
    }
    if (overview.connectionCheck?.kind === "UNEXPECTED") {
        return "Saved — server response needs attention.";
    }
    if (overview.status.lastSuccessfulAt !== undefined) {
        return "Connected during the last successful synchronization.";
    }
    return "Saved — not verified yet.";
}

export function vaultIdentityDescription(overview: SyncOverview): string {
    if (overview.vaultId !== undefined) {
        return overview.vaultId;
    }
    if (overview.connectionCheck?.kind === "CONNECTED") {
        return overview.connectionCheck.vault.vaultId;
    }
    return "Not verified yet.";
}

export function describeSyncResult(status: SyncStatus): string {
    if (status.kind === "FIRST_SYNC" || status.kind === "SYNCING") {
        return "Synchronization is in progress.";
    }
    if (status.kind === "SETUP_REQUIRED") {
        return "Connect a Server URL before the first synchronization.";
    }
    if (status.kind === "PAUSED") {
        return "Synchronization is paused; local changes remain queued safely.";
    }
    if (status.kind === "OFFLINE") {
        return "The server was unavailable. Pending work remains on this device.";
    }
    if (status.kind === "AUTHENTICATION_REQUIRED") {
        return "This Vault requires a valid access token. Pending work remains on this device.";
    }
    if (status.kind === "ERROR") {
        if (status.summary?.vaultRestored === true) {
            return "The server Vault was restored from a backup; no changes were sent. Run Reconnect to restored server Vault.";
        }
        return status.summary?.vaultMismatch === true
            ? "The selected server belongs to a different Vault; no changes were sent."
            : "The last synchronization did not complete. Pending work remains on this device.";
    }

    const summary = status.summary;
    if (summary === undefined) {
        return status.lastSuccessfulAt === undefined
            ? "No sync has completed in this session yet."
            : "Detailed results will be available after the next synchronization.";
    }

    const parts: string[] = [];
    if (summary.committed > 0) {
        parts.push(
            `${summary.committed} change${summary.committed === 1 ? "" : "s"} accepted by the server`,
        );
    }
    if (summary.conflicted > 0) {
        parts.push(
            `${summary.conflicted} conflict${summary.conflicted === 1 ? "" : "s"} need review`,
        );
    }
    if (summary.oversized > 0) {
        parts.push(
            `${summary.oversized} file${summary.oversized === 1 ? "" : "s"} exceed the size limit`,
        );
    }
    const result =
        parts.length === 0
            ? "No changes were required."
            : `${parts.join("; ")}.`;
    return summary.initialBootstrap === true
        ? `First sync checked the Server Vault. ${result}`
        : result;
}

export function describeCount(
    count: number,
    singular: string,
    plural: string,
): string {
    if (count === 0) {
        return `No ${plural}.`;
    }
    return `${count} ${count === 1 ? singular : plural}.`;
}

export function resetDescription(
    eligibility: SyncTrackingResetEligibility,
): string {
    if (eligibility.eligible) {
        return "Ready to reset. Notes and server files will not be deleted.";
    }
    return resetBlockedMessage(eligibility);
}

export function resetBlockedMessage(
    eligibility: SyncTrackingResetEligibility,
): string {
    const blockers: string[] = [];
    if (eligibility.pendingCount > 0) {
        blockers.push(
            describeCount(
                eligibility.pendingCount,
                "pending change",
                "pending changes",
            ),
        );
    }
    if (eligibility.conflictCount > 0) {
        blockers.push(
            describeCount(eligibility.conflictCount, "conflict", "conflicts"),
        );
    }
    if (eligibility.storedOperationCount > eligibility.pendingCount) {
        blockers.push("Earlier synchronization work still needs confirmation.");
    }
    if (eligibility.recoveryOperationCount > 0) {
        blockers.push("Recovery work is still in progress.");
    }
    return `Reset is unavailable. ${blockers.join(" ")} Review and resolve these items first.`;
}

export function syncStatusLabel(status: SyncStatus): string {
    if (status.kind === "SETUP_REQUIRED") {
        return "VaultDatum: Connect server";
    }
    if (status.kind === "AUTHENTICATION_REQUIRED") {
        return "VaultDatum: Access token required";
    }
    if (status.kind === "FIRST_SYNC") {
        return "VaultDatum: First sync";
    }
    if (status.kind === "SYNCING") {
        return "VaultDatum: Syncing";
    }
    if (status.kind === "UP_TO_DATE") {
        return "VaultDatum: Up to date";
    }
    if (status.kind === "PENDING") {
        const count = status.activity?.pendingCount;
        return count === undefined
            ? "VaultDatum: Pending"
            : `VaultDatum: ${count} change${count === 1 ? "" : "s"} pending`;
    }
    if (status.kind === "OFFLINE") {
        return "VaultDatum: Offline";
    }
    if (status.kind === "CONFLICT") {
        const count = status.activity?.conflictCount;
        return count === undefined
            ? "VaultDatum: Conflict"
            : `VaultDatum: Review conflict${count === 1 ? "" : "s"} (${count})`;
    }
    if (status.kind === "ERROR") {
        if (status.summary?.vaultRestored === true) {
            return "VaultDatum: Server restored";
        }
        return status.summary?.vaultMismatch
            ? "VaultDatum: Different Vault"
            : "VaultDatum: Error";
    }
    if (status.kind === "PAUSED") {
        return "VaultDatum: Paused";
    }
    return "VaultDatum: Ready";
}

export function syncStatusDescription(status: SyncStatus): string {
    const lastSuccess =
        status.lastSuccessfulAt === undefined
            ? ""
            : ` Last successful sync: ${new Date(status.lastSuccessfulAt).toLocaleString()}.`;

    if (status.kind === "SETUP_REQUIRED") {
        return "Connect a Server URL to start synchronization.";
    }
    if (status.kind === "AUTHENTICATION_REQUIRED") {
        return "Enter a valid Vault access token. Pending work remains on this device and will not retry until the token changes.";
    }
    if (status.kind === "FIRST_SYNC") {
        return `First sync: ${syncPhaseDescription(status.phase, true)}`;
    }
    if (status.kind === "SYNCING") {
        return `Synchronization: ${syncPhaseDescription(status.phase, false)}`;
    }
    if (status.kind === "UP_TO_DATE") {
        return `The local Vault is up to date.${lastSuccess}`;
    }
    if (status.kind === "PENDING") {
        const count = status.activity?.pendingCount;
        return `${count === undefined ? "Some" : count} local change${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} waiting to be synchronized.${lastSuccess}`;
    }
    if (status.kind === "OFFLINE") {
        return `The server is unavailable. Pending work is kept locally and will retry automatically.${lastSuccess}`;
    }
    if (status.kind === "CONFLICT") {
        return `Some paths need conflict resolution before they can converge.${lastSuccess}`;
    }
    if (status.kind === "ERROR") {
        if (status.summary?.vaultRestored === true) {
            return "The server Vault was restored from a backup. Run Reconnect to restored server Vault to continue. Existing changes were not sent.";
        }
        if (status.summary?.vaultMismatch) {
            return "This Server belongs to a different Vault. Existing changes were not sent.";
        }
        return `The last synchronization could not complete. Pending work is kept locally.${lastSuccess}`;
    }
    if (status.kind === "PAUSED") {
        return "Synchronization is paused. Local changes continue to be recorded safely.";
    }
    return "Ready to synchronize when a server URL is configured.";
}

function syncPhaseDescription(
    phase: SyncStatus["phase"],
    firstSync: boolean,
): string {
    if (phase === "CHECKING_SERVER_VAULT") {
        return firstSync
            ? "checking the Server Vault before classifying this device's files."
            : "checking the Server Vault.";
    }
    if (phase === "CLASSIFYING_LOCAL_FILES") {
        return firstSync
            ? "safely classifying this device's existing files."
            : "checking local changes.";
    }
    if (phase === "CHECKING_SERVER_CHANGES") {
        return "checking Server changes.";
    }
    if (phase === "SENDING_LOCAL_CHANGES") {
        return "sending local changes.";
    }
    if (phase === "VERIFYING_RESULTS") {
        return "verifying saved changes.";
    }
    return firstSync
        ? "checking the Server Vault before classifying this device's files."
        : "in progress.";
}
