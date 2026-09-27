import {
    App,
    FuzzySuggestModal,
    Modal,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    type FuzzyMatch,
    TFile,
    TFolder,
} from "obsidian";

import {
    exceedsSyncContentLimit,
    MAX_SYNC_CONTENT_BYTES,
} from "./core/content-limits";
import {
    composeManualMergeResult,
    createManualMergeDiff,
    manualMergeChangeBlocks,
    manualMergeChoiceRows,
    type ManualMergeChangeBlock,
    type ManualMergeDiff,
    type ManualMergeLine,
    type ManualMergeChoiceRow,
    type ManualMergeSource,
} from "./core/manual-merge-diff";
import {
    ClientStore,
    type ClientSyncActivity,
    type RemoteConflict,
    type SyncTrackingResetEligibility,
} from "./storage/client-store";
import { CreateSync, type SyncSummary } from "./sync/create-sync";
import { NotificationChannel } from "./sync/notification-channel";
import type { LocalVault } from "./sync/remote-apply";
import {
    SyncScheduler,
    SyncNotConfiguredError,
    SyncPausedError,
    type SyncActivity,
    type SyncStatus,
} from "./sync/sync-scheduler";
import { ServerAuthenticationError } from "./transport/access-token";
import { ServerClient, type RemoteVaultInfo } from "./transport/server-client";

interface VaultDatumSettings {
    serverUrl: string;
    vaultAccessToken: string;
    databaseName: string;
    syncEnabled: boolean;
}

const DEFAULT_SETTINGS: VaultDatumSettings = {
    serverUrl: "",
    vaultAccessToken: "",
    databaseName: "",
    syncEnabled: true,
};

type ConnectionCheck =
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

interface SyncOverview {
    readonly status: SyncStatus;
    readonly activity: ClientSyncActivity;
    readonly resetEligibility: SyncTrackingResetEligibility;
    readonly serverUrl: string;
    readonly vaultId?: string;
    readonly connectionCheck?: ConnectionCheck;
}

type OverviewAction =
    | "CONNECT"
    | "UPDATE_TOKEN"
    | "REVIEW_CONNECTION"
    | "RETRY"
    | "RESUME"
    | "REVIEW_CONFLICTS"
    | "SYNC";

export default class VaultDatumPlugin extends Plugin {
    private syncSettings: VaultDatumSettings = { ...DEFAULT_SETTINGS };

    private readonly serverClient = new ServerClient(() =>
        this.vaultAccessToken(),
    );

    private store: ClientStore | undefined;

    private createSync: CreateSync | undefined;

    private notificationChannel: NotificationChannel | undefined;

    private syncScheduler: SyncScheduler | undefined;

    private syncStatus: SyncStatus = { kind: "IDLE" };

    private lastConnectionCheck: ConnectionCheck | undefined;

    private syncStatusBar: HTMLElement | undefined;

    private settingsTab: VaultDatumSettingTab | undefined;

    private captureQueue: Promise<void> = Promise.resolve();

    private lastPersistedSuccessfulAt: string | undefined;

    private observedConflictCount: number | undefined;

    private resetInProgress = false;

    private connectionSettingsGeneration = 0;

    private authenticationRequiredAtGeneration: number | undefined;

    public async onload(): Promise<void> {
        await this.loadSettings();
        this.store = await ClientStore.open(this.syncSettings.databaseName);
        this.lastPersistedSuccessfulAt =
            await this.store.lastSuccessfulSyncAt();
        this.createSync = new CreateSync(
            this.store,
            this.serverClient,
            new ObsidianLocalVault(this.app),
            () => this.serverUrl(),
        );
        this.syncScheduler = new SyncScheduler({
            run: (mode, reportProgress): Promise<SyncSummary> => {
                const createSync = this.createSync;
                if (createSync === undefined) {
                    return Promise.reject(
                        new Error("VaultDatum sync is not initialized"),
                    );
                }
                return mode === "FULL"
                    ? createSync.fullReconcile(reportProgress)
                    : createSync.sync(reportProgress);
            },
            readActivity: async (): Promise<SyncActivity> => {
                const store = this.store;
                if (store === undefined) {
                    return {
                        hasPending: false,
                        hasConflicts: false,
                        initialBootstrapComplete: false,
                    };
                }
                const activity = await store.syncActivity();
                return {
                    hasPending: activity.pendingCount > 0,
                    hasConflicts: activity.conflictCount > 0,
                    pendingCount: activity.pendingCount,
                    conflictCount: activity.conflictCount,
                    initialBootstrapComplete: activity.initialBootstrapComplete,
                };
            },
            isConfigured: (): boolean => this.serverUrl().length > 0,
            isEnabled: (): boolean =>
                this.syncSettings.syncEnabled && !this.resetInProgress,
            initialLastSuccessfulAt: this.lastPersistedSuccessfulAt,
            onStatus: (status: SyncStatus): void =>
                this.updateSyncStatus(status),
        });
        if (!Platform.isMobile) {
            this.syncStatusBar = this.addStatusBarItem();
            this.syncStatusBar.setAttribute("role", "button");
            this.syncStatusBar.tabIndex = 0;
            this.registerDomEvent(this.syncStatusBar, "click", () => {
                this.openSyncOverview();
            });
            this.registerDomEvent(this.syncStatusBar, "keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    this.openSyncOverview();
                }
            });
            this.updateSyncStatus(this.syncStatus);
        }
        this.notificationChannel = new NotificationChannel(
            () => this.serverUrl(),
            () => this.vaultAccessToken().length > 0,
            (serverUrl) => this.serverClient.createRealtimeTicket(serverUrl),
            () => {
                void this.syncNow(false);
            },
            () => {
                void this.syncNow(false);
            },
        );
        this.settingsTab = new VaultDatumSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);
        this.addCommand({
            id: "sync-now",
            name: "Sync now",
            callback: () => {
                void this.syncNow(true);
            },
        });
        this.addCommand({
            id: "open-sync-overview",
            name: "Open sync overview",
            callback: () => {
                this.openSyncOverview();
            },
        });
        this.addCommand({
            id: "pause-sync",
            name: "Pause synchronization",
            checkCallback: (checking) => {
                if (!this.syncSettings.syncEnabled) {
                    return false;
                }
                if (!checking) {
                    void this.setSyncEnabled(false);
                }
                return true;
            },
        });
        this.addCommand({
            id: "resume-sync",
            name: "Resume synchronization",
            checkCallback: (checking) => {
                if (this.syncSettings.syncEnabled) {
                    return false;
                }
                if (!checking) {
                    void this.setSyncEnabled(true);
                }
                return true;
            },
        });
        this.addCommand({
            id: "full-reconcile",
            name: "Full reconciliation",
            callback: () => {
                void this.fullReconcile(true);
            },
        });
        this.addCommand({
            id: "resolve-conflict-use-server",
            name: "Resolve conflict: use Server",
            callback: () => {
                void this.openUseServerConflictPicker();
            },
        });
        this.addCommand({
            id: "resolve-conflict-apply-local",
            name: "Resolve conflict: apply Local",
            callback: () => {
                void this.openApplyLocalConflictPicker();
            },
        });
        this.addCommand({
            id: "resolve-conflict-keep-deleted",
            name: "Resolve conflict: keep Deleted",
            callback: () => {
                void this.openKeepDeletedConflictPicker();
            },
        });
        this.addCommand({
            id: "resolve-conflict-restore-local",
            name: "Resolve conflict: restore Local",
            callback: () => {
                void this.openRestoreLocalConflictPicker();
            },
        });
        this.addCommand({
            id: "resolve-conflict-keep-both",
            name: "Resolve conflict: keep Both",
            callback: () => {
                void this.openKeepBothConflictPicker();
            },
        });
        this.addCommand({
            id: "resolve-conflict-manual-merge",
            name: "Resolve conflict: merge manually",
            callback: () => {
                void this.openManualMergeConflictPicker();
            },
        });

        this.app.workspace.onLayoutReady(() => {
            this.observeVaultChanges();
            if (this.syncSettings.syncEnabled) {
                this.notificationChannel?.start();
            }
            void this.syncNow(false);
        });
        this.registerDomEvent(window, "online", () => {
            void this.syncNow(false);
        });
        this.registerDomEvent(document, "visibilitychange", () => {
            if (document.visibilityState === "visible") {
                void this.syncNow(false);
            }
        });
    }

    public onunload(): void {
        this.syncScheduler?.dispose();
        this.notificationChannel?.stop();
        this.store?.close();
    }

    public async updateConnectionSettings(
        serverUrl: string,
        vaultAccessToken: string,
    ): Promise<ConnectionCheck> {
        const normalized = normalizeServerUrl(serverUrl);
        const normalizedToken = vaultAccessToken.trim();
        if (normalized === undefined) {
            return this.rememberConnectionCheck({
                kind: "INVALID_URL",
                message: "Enter a complete http:// or https:// server URL.",
            });
        }
        if (normalizedToken.length > 0 && !isHttpsUrl(normalized)) {
            return this.rememberConnectionCheck({
                kind: "INVALID_URL",
                message:
                    "A Vault access token can only be used with an https:// server URL.",
            });
        }
        const connection = await this.testServerConnection(
            normalized,
            normalizedToken,
        );
        if (
            connection.kind === "CONNECTED" &&
            !connection.matchesCurrentVault
        ) {
            return connection;
        }

        this.syncSettings.serverUrl = normalized;
        this.syncSettings.vaultAccessToken = normalizedToken;
        this.connectionSettingsGeneration += 1;
        this.authenticationRequiredAtGeneration = undefined;
        await this.saveSettings();
        if (this.syncSettings.syncEnabled) {
            this.notificationChannel?.restart();
        }
        void this.syncNow(false);
        return connection;
    }

    public async resetConnectionSettings(): Promise<boolean> {
        if (this.syncScheduler?.isBusy() === true) {
            new Notice(
                "Wait for the current synchronization to finish before resetting connection settings.",
            );
            return false;
        }
        this.notificationChannel?.stop();
        this.lastConnectionCheck = undefined;
        this.syncSettings.serverUrl = DEFAULT_SETTINGS.serverUrl;
        this.syncSettings.vaultAccessToken = DEFAULT_SETTINGS.vaultAccessToken;
        this.connectionSettingsGeneration += 1;
        this.authenticationRequiredAtGeneration = undefined;
        this.syncSettings.syncEnabled = DEFAULT_SETTINGS.syncEnabled;
        await this.saveSettings();
        this.syncScheduler?.refreshAvailability();
        new Notice(
            "VaultDatum connection settings were reset. Local notes and sync tracking were not changed.",
        );
        return true;
    }

    public serverUrl(): string {
        return normalizeServerUrl(this.syncSettings.serverUrl) ?? "";
    }

    public vaultAccessToken(): string {
        return this.syncSettings.vaultAccessToken.trim();
    }

    public syncStatusDescription(): string {
        return syncStatusDescription(this.syncStatus);
    }

    public isSyncEnabled(): boolean {
        return this.syncSettings.syncEnabled;
    }

    public async requestManualSync(): Promise<void> {
        await this.syncNow(true);
    }

    public async requestFullReconciliation(): Promise<void> {
        await this.fullReconcile(true);
    }

    public async testServerConnection(
        serverUrl: string,
        vaultAccessToken = this.vaultAccessToken(),
    ): Promise<ConnectionCheck> {
        const normalized = normalizeServerUrl(serverUrl);
        if (normalized === undefined) {
            return this.rememberConnectionCheck({
                kind: "INVALID_URL",
                message: "Enter a complete http:// or https:// server URL.",
            });
        }
        if (vaultAccessToken.trim().length > 0 && !isHttpsUrl(normalized)) {
            return this.rememberConnectionCheck({
                kind: "INVALID_URL",
                message:
                    "A Vault access token can only be used with an https:// server URL.",
            });
        }

        try {
            const result = await new ServerClient(
                () => vaultAccessToken,
            ).readVault(normalized);
            if (result.kind !== "OK") {
                return this.rememberConnectionCheck({
                    kind: "UNAVAILABLE",
                    serverUrl: normalized,
                    message:
                        "The server could not be reached. Check the URL and private network connection.",
                });
            }

            const knownVaultId = (await this.store?.syncState())?.vaultId;
            return this.rememberConnectionCheck({
                kind: "CONNECTED",
                serverUrl: normalized,
                vault: result.value,
                matchesCurrentVault:
                    knownVaultId === undefined ||
                    knownVaultId === result.value.vaultId,
            });
        } catch (error: unknown) {
            if (error instanceof ServerAuthenticationError) {
                return this.rememberConnectionCheck({
                    kind: "AUTHENTICATION_REQUIRED",
                    serverUrl: normalized,
                    message:
                        "Authentication required. Enter this Vault's access token.",
                });
            }
            return this.rememberConnectionCheck({
                kind: "UNEXPECTED",
                serverUrl: normalized,
                message:
                    "The server returned an unexpected response. Open diagnostic details if the problem continues.",
            });
        }
    }

    private rememberConnectionCheck(
        connection: ConnectionCheck,
    ): ConnectionCheck {
        this.lastConnectionCheck = connection;
        this.settingsTab?.refreshOverview();
        return connection;
    }

    private matchingConnectionCheck(): ConnectionCheck | undefined {
        const connection = this.lastConnectionCheck;
        if (
            connection === undefined ||
            !("serverUrl" in connection) ||
            connection.serverUrl !== this.serverUrl()
        ) {
            return undefined;
        }
        return connection;
    }

    public async syncOverview(): Promise<SyncOverview | undefined> {
        const store = this.store;
        if (store === undefined) {
            return undefined;
        }

        const [activity, resetEligibility, state] = await Promise.all([
            store.syncActivity(),
            store.resetEligibility(),
            store.syncState(),
        ]);
        return {
            status: this.syncStatus,
            activity,
            resetEligibility,
            serverUrl: this.serverUrl(),
            vaultId: state.vaultId,
            connectionCheck: this.matchingConnectionCheck(),
        };
    }

    public async setSyncEnabled(enabled: boolean): Promise<void> {
        if (this.syncSettings.syncEnabled === enabled) {
            return;
        }

        this.syncSettings.syncEnabled = enabled;
        await this.saveSettings();
        if (enabled) {
            this.notificationChannel?.restart();
            this.syncScheduler?.refreshAvailability();
            void this.syncNow(false);
            return;
        }

        this.notificationChannel?.stop();
        this.syncScheduler?.refreshAvailability();
    }

    public async requestResetSyncTracking(): Promise<void> {
        const store = this.store;
        const scheduler = this.syncScheduler;
        if (store === undefined || scheduler === undefined) {
            return;
        }
        if (scheduler.isBusy()) {
            new Notice(
                "Wait for the current synchronization to finish before resetting sync tracking.",
            );
            return;
        }

        await this.captureQueue;
        const eligibility = await store.resetEligibility();
        if (!eligibility.eligible) {
            new Notice(resetBlockedMessage(eligibility));
            return;
        }

        new ResetSyncTrackingModal(this.app, async () => {
            await this.resetSyncTracking();
        }).open();
    }

    public async copyDiagnosticDetails(): Promise<void> {
        const store = this.store;
        if (store === undefined) {
            return;
        }

        const [activity, state] = await Promise.all([
            store.syncActivity(),
            store.syncState(),
        ]);
        const diagnostic = [
            `VaultDatum client version: ${this.manifest.version}`,
            `Platform: ${Platform.isMobile ? "mobile" : "desktop"}`,
            `Sync status: ${this.syncStatus.kind}`,
            `Vault ID: ${state.vaultId ?? "not connected"}`,
            `Server cursor: ${state.serverCursor}`,
            `Pending changes: ${activity.pendingCount}`,
            `Conflicts: ${activity.conflictCount}`,
            `Initial bootstrap complete: ${activity.initialBootstrapComplete}`,
            `Last successful sync: ${this.syncStatus.lastSuccessfulAt ?? "none"}`,
        ].join("\n");

        try {
            await navigator.clipboard.writeText(diagnostic);
            new Notice("VaultDatum diagnostic details copied.");
        } catch {
            new Notice("VaultDatum could not copy diagnostic details.");
        }
    }

    public openSyncOverview(): void {
        const settings = (
            this.app as unknown as {
                readonly setting?: {
                    open(): void;
                    openTabById(id: string): void;
                };
            }
        ).setting;
        if (settings === undefined) {
            new Notice(
                "Open VaultDatum settings to view synchronization status.",
            );
            return;
        }
        settings.open();
        settings.openTabById(this.manifest.id);
    }

    private observeVaultChanges(): void {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (!(file instanceof TFile)) {
                    return;
                }

                this.captureQueue = this.captureQueue.then(() =>
                    this.captureContentChange(createSync, file),
                );
            }),
        );
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!(file instanceof TFile)) {
                    return;
                }

                this.captureQueue = this.captureQueue.then(() =>
                    this.captureContentChange(createSync, file),
                );
            }),
        );
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                this.captureQueue = this.captureQueue.then(async () => {
                    if (file instanceof TFile) {
                        await this.captureDeletedFile(createSync, file.path);
                    } else if (file instanceof TFolder) {
                        await this.captureDeletedDirectory(
                            createSync,
                            file.path,
                        );
                    }
                });
            }),
        );
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                this.captureQueue = this.captureQueue.then(async () => {
                    if (file instanceof TFile) {
                        await this.captureFilePathChange(
                            createSync,
                            oldPath,
                            file.path,
                        );
                    } else if (file instanceof TFolder) {
                        await this.captureDirectoryPathChange(
                            createSync,
                            oldPath,
                            file.path,
                        );
                    }
                });
            }),
        );
    }

    private async captureContentChange(
        createSync: CreateSync,
        file: TFile,
    ): Promise<void> {
        if (exceedsSyncContentLimit(file.stat.size)) {
            new Notice(
                `VaultDatum cannot sync ${file.path}: files must be ${maximumContentSizeLabel()} or smaller.`,
            );
            this.scheduleAutomaticSync();
            return;
        }

        try {
            const content = await this.app.vault.readBinary(file);
            const pending = await createSync.captureModify(file.path, content);

            if (pending !== undefined) {
                this.scheduleAutomaticSync();
            }
        } catch {
            console.warn(
                "VaultDatum could not persist a created file for synchronization",
            );
            new Notice(
                "VaultDatum could not queue a newly created file. The local file was not changed.",
            );
        }
    }

    private async captureDeletedFile(
        createSync: CreateSync,
        path: string,
    ): Promise<void> {
        try {
            const pending = await createSync.captureDelete(path);

            if (pending !== undefined) {
                this.scheduleAutomaticSync();
            }
        } catch {
            console.warn(
                "VaultDatum could not persist a deleted file for synchronization",
            );
            new Notice(
                "VaultDatum could not queue a deleted file. The local file was not restored.",
            );
        }
    }

    private async captureFilePathChange(
        createSync: CreateSync,
        sourcePath: string,
        destinationPath: string,
    ): Promise<void> {
        try {
            const pending = await createSync.captureFilePathChange(
                sourcePath,
                destinationPath,
            );

            if (pending !== undefined) {
                this.scheduleAutomaticSync();
            }
        } catch {
            console.warn("VaultDatum could not queue a renamed file");
            new Notice(
                "VaultDatum could not queue a renamed file. The local file was not changed.",
            );
        }
    }

    private async captureDeletedDirectory(
        createSync: CreateSync,
        path: string,
    ): Promise<void> {
        try {
            const pending = await createSync.captureDirectoryDelete(path);

            if (pending !== undefined) {
                this.scheduleAutomaticSync();
            }
        } catch {
            console.warn("VaultDatum could not queue a deleted directory");
            new Notice(
                "VaultDatum could not queue a deleted directory. The local directory was not restored.",
            );
        }
    }

    private async captureDirectoryPathChange(
        createSync: CreateSync,
        sourcePath: string,
        destinationPath: string,
    ): Promise<void> {
        try {
            const pending = await createSync.captureDirectoryPathChange(
                sourcePath,
                destinationPath,
            );

            if (pending !== undefined) {
                this.scheduleAutomaticSync();
            }
        } catch {
            console.warn("VaultDatum could not queue a renamed directory");
            new Notice(
                "VaultDatum could not queue a renamed directory. The local directory was not changed.",
            );
        }
    }

    private async syncNow(showResult: boolean): Promise<void> {
        const scheduler = this.syncScheduler;

        if (scheduler === undefined) {
            return;
        }
        if (
            !showResult &&
            this.authenticationRequiredAtGeneration ===
                this.connectionSettingsGeneration
        ) {
            return;
        }

        try {
            const summary = await scheduler.request();

            if (showResult) {
                this.showSyncResult(summary);
            }
        } catch (error: unknown) {
            if (error instanceof SyncNotConfiguredError) {
                if (showResult) {
                    new Notice("Configure a Server URL before syncing.");
                }
                return;
            }
            if (error instanceof SyncPausedError) {
                if (showResult) {
                    new Notice("VaultDatum synchronization is paused.");
                }
                return;
            }
            console.warn("VaultDatum synchronization failed");
            if (showResult) {
                new Notice(
                    "VaultDatum synchronization could not complete. Pending work is kept locally.",
                );
            }
        }
    }

    private scheduleAutomaticSync(): void {
        this.settingsTab?.refreshOverview();
        void this.syncNow(false);
    }

    private async fullReconcile(showResult: boolean): Promise<void> {
        const scheduler = this.syncScheduler;

        if (scheduler === undefined) {
            return;
        }

        try {
            const summary = await scheduler.request("FULL");

            if (showResult) {
                this.showSyncResult(summary);
            }
        } catch (error: unknown) {
            if (error instanceof SyncNotConfiguredError) {
                if (showResult) {
                    new Notice(
                        "Configure a Server URL before checking all files.",
                    );
                }
                return;
            }
            if (error instanceof SyncPausedError) {
                if (showResult) {
                    new Notice(
                        "Resume synchronization before checking all files.",
                    );
                }
                return;
            }
            console.warn("VaultDatum full reconciliation failed");
            if (showResult) {
                new Notice(
                    "VaultDatum could not complete full reconciliation. Pending work is kept locally.",
                );
            }
        }
    }

    public async openConflictOverview(noticeWhenEmpty = true): Promise<void> {
        const store = this.store;
        if (store === undefined) {
            return;
        }

        const conflicts = await store.conflicts();
        if (conflicts.length === 0) {
            if (noticeWhenEmpty) {
                new Notice("VaultDatum has no conflicts to review.");
            }
            return;
        }

        new ConflictOverviewModal(this.app, conflicts, (conflict) =>
            this.openConflictActions(conflict),
        ).open();
    }

    private openConflictActions(conflict: RemoteConflict): void {
        const localFile =
            this.app.vault.getAbstractFileByPath(conflict.path) instanceof
            TFile;
        const serverFile =
            conflict.serverState.entryType === "FILE" &&
            conflict.serverState.state === "PRESENT";
        const actions: ConflictAction[] = [
            {
                label: "Use Server version",
                description:
                    "Replace this device's version with the latest Server version.",
                run: async (): Promise<void> => {
                    if (await this.resolveUseServer(conflict)) {
                        void this.openConflictOverview(false);
                    }
                },
            },
        ];

        if (serverFile && localFile) {
            actions.push(
                {
                    label: "Apply this device's version",
                    description:
                        "Create a new change against the latest Server version.",
                    run: async (): Promise<void> => {
                        if (await this.resolveApplyLocal(conflict)) {
                            void this.openConflictOverview(false);
                        }
                    },
                },
                {
                    label: "Keep both versions",
                    description:
                        "Keep the Server version at this path and save this device's version separately.",
                    run: async (): Promise<void> => {
                        this.openKeepBothDestination(conflict, true);
                    },
                },
            );
            if (conflict.path.toLowerCase().endsWith(".md")) {
                actions.push({
                    label: "Merge Markdown manually",
                    description:
                        "Compare both Markdown versions and save a merged result as a new change.",
                    run: async (): Promise<void> => {
                        await this.openManualMergeEditor(conflict, true);
                    },
                });
            }
        } else if (serverFile) {
            actions.push({
                label: "Keep this device's deletion",
                description:
                    "Create a deletion request against the latest Server version.",
                run: async (): Promise<void> => {
                    if (await this.resolveKeepDeleted(conflict)) {
                        void this.openConflictOverview(false);
                    }
                },
            });
        } else if (conflict.serverState.state === "DELETED" && localFile) {
            actions.push({
                label: "Restore this device's version",
                description:
                    "Create a new restore request from this device's version.",
                run: async (): Promise<void> => {
                    if (await this.resolveRestoreLocal(conflict)) {
                        void this.openConflictOverview(false);
                    }
                },
            });
        }
        new ConflictActionModal(this.app, conflict, actions).open();
    }

    private async openUseServerConflictPicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }

        const conflicts = await store.conflicts();
        if (conflicts.length === 0) {
            new Notice("VaultDatum has no conflicts to resolve.");
            return;
        }

        new ConflictResolutionModal(
            this.app,
            conflicts,
            "Choose a conflict to replace with the Server version",
            async (conflict): Promise<void> => {
                await this.resolveUseServer(conflict);
            },
        ).open();
    }

    private async resolveUseServer(conflict: RemoteConflict): Promise<boolean> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return false;
        }

        try {
            if (await createSync.resolveUseServer(conflict.path)) {
                new Notice(
                    `VaultDatum replaced ${conflict.path} with the Server version.`,
                );
                void this.syncNow(false);
                return true;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
            return false;
        } catch {
            console.warn("VaultDatum could not apply the Server version");
            new Notice(
                "VaultDatum could not apply the Server version. The conflict was kept.",
            );
            return false;
        }
    }

    private async openApplyLocalConflictPicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }

        const conflicts = await store.conflicts();
        if (conflicts.length === 0) {
            new Notice("VaultDatum has no conflicts to resolve.");
            return;
        }

        new ConflictResolutionModal(
            this.app,
            conflicts,
            "Choose a conflict to apply as a new local change",
            async (conflict): Promise<void> => {
                await this.resolveApplyLocal(conflict);
            },
        ).open();
    }

    private async resolveApplyLocal(
        conflict: RemoteConflict,
    ): Promise<boolean> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return false;
        }

        try {
            if (await createSync.resolveApplyLocal(conflict.path)) {
                new Notice(
                    `VaultDatum queued ${conflict.path} as a new local change.`,
                );
                void this.syncNow(false);
                return true;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
            return false;
        } catch {
            console.warn("VaultDatum could not prepare the local version");
            new Notice(
                "VaultDatum could not apply the local version. The conflict was kept.",
            );
            return false;
        }
    }

    private async openKeepDeletedConflictPicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }

        const conflicts = await store.conflicts();
        if (conflicts.length === 0) {
            new Notice("VaultDatum has no conflicts to resolve.");
            return;
        }

        new ConflictResolutionModal(
            this.app,
            conflicts,
            "Choose a deleted local file to keep deleted",
            async (conflict): Promise<void> => {
                await this.resolveKeepDeleted(conflict);
            },
        ).open();
    }

    private async resolveKeepDeleted(
        conflict: RemoteConflict,
    ): Promise<boolean> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return false;
        }

        try {
            if (await createSync.resolveKeepDeleted(conflict.path)) {
                new Notice(`VaultDatum queued deletion of ${conflict.path}.`);
                void this.syncNow(false);
                return true;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
            return false;
        } catch {
            console.warn("VaultDatum could not prepare the local deletion");
            new Notice(
                "VaultDatum could not keep that deletion. The conflict was kept.",
            );
            return false;
        }
    }

    private async openRestoreLocalConflictPicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }

        const conflicts = (await store.conflicts()).filter(
            (conflict) => conflict.serverState.state === "DELETED",
        );
        if (conflicts.length === 0) {
            new Notice("VaultDatum has no deleted Server paths to restore.");
            return;
        }

        new ConflictResolutionModal(
            this.app,
            conflicts,
            "Choose a deleted Server path to restore from this device",
            async (conflict): Promise<void> => {
                await this.resolveRestoreLocal(conflict);
            },
        ).open();
    }

    private async resolveRestoreLocal(
        conflict: RemoteConflict,
    ): Promise<boolean> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return false;
        }

        try {
            if (await createSync.resolveRestoreLocal(conflict.path)) {
                new Notice(
                    `VaultDatum queued restoration of ${conflict.path}.`,
                );
                void this.syncNow(false);
                return true;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
            return false;
        } catch {
            console.warn("VaultDatum could not prepare the local restoration");
            new Notice(
                "VaultDatum could not restore that file. The conflict was kept.",
            );
            return false;
        }
    }

    private async openKeepBothConflictPicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }

        const conflicts = await store.conflicts();
        if (conflicts.length === 0) {
            new Notice("VaultDatum has no conflicts to resolve.");
            return;
        }

        new ConflictResolutionModal(
            this.app,
            conflicts,
            "Choose a conflict to keep as a second local file",
            async (conflict): Promise<void> => {
                this.openKeepBothDestination(conflict);
            },
        ).open();
    }

    private openKeepBothDestination(
        conflict: RemoteConflict,
        returnToOverview = false,
    ): void {
        new KeepBothDestinationModal(
            this.app,
            conflict.path,
            async (destinationPath): Promise<boolean> => {
                const resolved = await this.resolveKeepBoth(
                    conflict,
                    destinationPath,
                );
                if (resolved && returnToOverview) {
                    void this.openConflictOverview(false);
                }
                return resolved;
            },
        ).open();
    }

    private async resolveKeepBoth(
        conflict: RemoteConflict,
        destinationPath: string,
    ): Promise<boolean> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return false;
        }

        try {
            if (
                await createSync.resolveKeepBoth(conflict.path, destinationPath)
            ) {
                new Notice(
                    `VaultDatum queued ${destinationPath} and restored ${conflict.path} from the Server.`,
                );
                void this.syncNow(false);
                return true;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
            return false;
        } catch {
            console.warn("VaultDatum could not keep both file versions");
            new Notice(
                "VaultDatum could not keep both files. The conflict was kept.",
            );
            return false;
        }
    }

    private async openManualMergeConflictPicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }
        const conflicts = (await store.conflicts()).filter((conflict) =>
            conflict.path.toLowerCase().endsWith(".md"),
        );
        if (conflicts.length === 0) {
            new Notice("VaultDatum has no Markdown conflicts to merge.");
            return;
        }

        new ConflictResolutionModal(
            this.app,
            conflicts,
            "Choose a Markdown conflict to merge manually",
            (conflict) => this.openManualMergeEditor(conflict),
        ).open();
    }

    private async openManualMergeEditor(
        conflict: RemoteConflict,
        returnToOverview = false,
    ): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            const versions = await createSync.manualMergeVersions(
                conflict.path,
            );
            new ManualMergeModal(
                this.app,
                conflict.path,
                new TextDecoder().decode(versions.server),
                new TextDecoder().decode(versions.local),
                async (merged): Promise<boolean> => {
                    const resolved = await this.resolveManualMerge(
                        conflict,
                        merged,
                    );
                    if (resolved && returnToOverview) {
                        void this.openConflictOverview(false);
                    }
                    return resolved;
                },
            ).open();
        } catch {
            console.warn("VaultDatum could not open a manual merge");
            new Notice(
                "VaultDatum could not load both file versions. The conflict was kept.",
            );
        }
    }

    private async resolveManualMerge(
        conflict: RemoteConflict,
        merged: string,
    ): Promise<boolean> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return false;
        }

        try {
            if (
                await createSync.resolveManualMerge(
                    conflict.path,
                    new TextEncoder().encode(merged).buffer,
                )
            ) {
                new Notice(`VaultDatum queued the merged ${conflict.path}.`);
                void this.syncNow(false);
                return true;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
            return false;
        } catch {
            console.warn("VaultDatum could not save a manual merge");
            new Notice(
                "VaultDatum could not save the merged file. The conflict was kept.",
            );
            return false;
        }
    }

    private showSyncResult(summary: SyncSummary): void {
        if (summary.vaultMismatch) {
            new Notice(
                "VaultDatum stopped because this local sync state belongs to another server Vault.",
            );
            return;
        }
        if (summary.authenticationRequired) {
            new Notice(
                "VaultDatum needs a valid Vault access token. Pending work remains on this device.",
            );
            return;
        }
        if (summary.oversized > 0) {
            new Notice(
                `VaultDatum skipped ${summary.oversized} file(s) larger than ${maximumContentSizeLabel()}.`,
            );
            return;
        }
        if (summary.offline) {
            new Notice(
                "VaultDatum is offline or no server URL is configured. Pending work is kept locally.",
            );
            return;
        }
        if (summary.conflicted > 0) {
            new Notice(
                `VaultDatum committed ${summary.committed} change(s); ${summary.conflicted} need resolution.`,
            );
            return;
        }

        new Notice(`VaultDatum committed ${summary.committed} change(s).`);
    }

    private updateSyncStatus(status: SyncStatus): void {
        const conflictCount = status.activity?.conflictCount;
        const newConflicts =
            conflictCount === undefined ||
            this.observedConflictCount === undefined ||
            conflictCount <= this.observedConflictCount
                ? 0
                : conflictCount - this.observedConflictCount;
        if (conflictCount !== undefined) {
            this.observedConflictCount = conflictCount;
        }
        this.syncStatus = status;
        if (status.kind === "AUTHENTICATION_REQUIRED") {
            this.authenticationRequiredAtGeneration =
                this.connectionSettingsGeneration;
            this.notificationChannel?.stop();
        } else {
            this.authenticationRequiredAtGeneration = undefined;
        }
        if (
            status.lastSuccessfulAt !== undefined &&
            status.lastSuccessfulAt !== this.lastPersistedSuccessfulAt
        ) {
            this.lastPersistedSuccessfulAt = status.lastSuccessfulAt;
            const store = this.store;
            if (store !== undefined) {
                void store
                    .recordSuccessfulSync(status.lastSuccessfulAt)
                    .catch((error: unknown) =>
                        console.warn(
                            "VaultDatum could not save the last successful sync time",
                            error,
                        ),
                    );
            }
        }
        if (newConflicts > 0) {
            new Notice(
                `VaultDatum found ${newConflicts} new conflict${newConflicts === 1 ? "" : "s"}. Open Sync Overview to review ${newConflicts === 1 ? "it" : "them"}.`,
            );
        }
        this.settingsTab?.refreshOverview();
        if (this.syncStatusBar === undefined) {
            return;
        }

        this.syncStatusBar.textContent = syncStatusLabel(status);
        this.syncStatusBar.title = syncStatusDescription(status);
        this.syncStatusBar.setAttribute(
            "aria-label",
            syncStatusDescription(status),
        );
    }

    private async resetSyncTracking(): Promise<void> {
        const store = this.store;
        const scheduler = this.syncScheduler;
        if (store === undefined || scheduler === undefined) {
            return;
        }
        if (scheduler.isBusy()) {
            throw new Error("VaultDatum synchronization is still running");
        }

        this.resetInProgress = true;
        this.notificationChannel?.stop();
        scheduler.refreshAvailability();
        try {
            await this.captureQueue;
            await store.resetSyncTracking();
            this.lastPersistedSuccessfulAt = undefined;
            new Notice(
                "VaultDatum sync tracking was reset. Your files were not changed.",
            );
        } catch (error: unknown) {
            console.warn("VaultDatum could not reset sync tracking", error);
            new Notice(
                "VaultDatum could not reset sync tracking. Your files were not changed.",
            );
            return;
        } finally {
            this.resetInProgress = false;
        }

        if (this.syncSettings.syncEnabled) {
            this.notificationChannel?.restart();
            scheduler.refreshAvailability();
            void this.syncNow(false);
        } else {
            scheduler.refreshAvailability();
        }
    }

    private async loadSettings(): Promise<void> {
        this.syncSettings = readSettings(await this.loadData());

        if (this.syncSettings.databaseName.length === 0) {
            this.syncSettings.databaseName = `vaultdatum:${crypto.randomUUID()}`;
            await this.saveSettings();
        }
    }

    private async saveSettings(): Promise<void> {
        await this.saveData(this.syncSettings);
    }
}

class ObsidianLocalVault implements LocalVault {
    public constructor(private readonly app: App) {}

    public async listFiles(): Promise<
        readonly { readonly path: string; readonly size: number }[]
    > {
        return this.app.vault
            .getFiles()
            .map((file) => ({ path: file.path, size: file.stat.size }));
    }

    public async listDirectories(): Promise<readonly string[]> {
        return this.app.vault
            .getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder)
            .map((folder) => folder.path)
            .filter((path) => path.length > 0);
    }

    public async directoryIsEmpty(path: string): Promise<boolean> {
        const directory = this.app.vault.getAbstractFileByPath(path);
        return directory instanceof TFolder && directory.children.length === 0;
    }

    public async directoryExists(path: string): Promise<boolean> {
        return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
    }

    public async createDirectory(path: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(path);

        if (existing instanceof TFolder) {
            return;
        }
        if (existing !== null) {
            throw new Error(
                "Cannot replace a local file with a remote directory",
            );
        }

        await this.createParentFolders(path);
        await this.app.vault.createFolder(path);
    }

    public async removeDirectory(path: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(path);

        if (existing === null) {
            return;
        }
        if (!(existing instanceof TFolder) || existing.children.length > 0) {
            throw new Error("Cannot remove a non-empty local directory");
        }

        await this.app.vault.delete(existing);
    }

    public async fileSize(path: string): Promise<number | undefined> {
        const file = this.app.vault.getAbstractFileByPath(path);

        return file instanceof TFile ? file.stat.size : undefined;
    }

    public async readFile(path: string): Promise<ArrayBuffer | undefined> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!(file instanceof TFile)) {
            return undefined;
        }

        return this.app.vault.readBinary(file);
    }

    public async writeFile(path: string, content: ArrayBuffer): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(path);

        if (existing instanceof TFile) {
            await this.app.vault.modifyBinary(existing, content);
            return;
        }
        if (existing !== null) {
            throw new Error(
                "Cannot replace a local folder with remote file content",
            );
        }

        await this.createParentFolders(path);
        await this.app.vault.createBinary(path, content);
    }

    public async removeFile(path: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(path);

        if (existing === null) {
            return;
        }
        if (!(existing instanceof TFile)) {
            throw new Error(
                "Cannot remove a local folder for a remote file change",
            );
        }

        await this.app.vault.delete(existing);
    }

    private async createParentFolders(path: string): Promise<void> {
        const segments = path.split("/");
        let current = "";

        for (const segment of segments.slice(0, -1)) {
            current = current.length === 0 ? segment : `${current}/${segment}`;
            const existing = this.app.vault.getAbstractFileByPath(current);

            if (existing === null) {
                await this.app.vault.createFolder(current);
                continue;
            }
            if (!(existing instanceof TFolder)) {
                throw new Error("Cannot create a local folder over a file");
            }
        }
    }
}

function maximumContentSizeLabel(): string {
    return `${MAX_SYNC_CONTENT_BYTES / (1024 * 1024)} MiB`;
}

interface ConflictAction {
    readonly label: string;
    readonly description: string;
    readonly run: () => Promise<void>;
}

class ConflictOverviewModal extends FuzzySuggestModal<RemoteConflict> {
    public constructor(
        app: App,
        private readonly conflicts: readonly RemoteConflict[],
        private readonly choose: (conflict: RemoteConflict) => void,
    ) {
        super(app);
        this.setPlaceholder("Choose a conflict to review");
    }

    public getItems(): RemoteConflict[] {
        return [...this.conflicts];
    }

    public getItemText(conflict: RemoteConflict): string {
        return `${conflict.path} ${conflictReason(conflict)}`;
    }

    public renderSuggestion(
        match: FuzzyMatch<RemoteConflict>,
        el: HTMLElement,
    ): void {
        el.createDiv({ text: match.item.path });
        el.createDiv({
            cls: "suggestion-note",
            text: conflictReason(match.item),
        });
    }

    public onChooseItem(conflict: RemoteConflict): void {
        this.choose(conflict);
    }
}

class ConflictActionModal extends Modal {
    public constructor(
        app: App,
        private readonly conflict: RemoteConflict,
        private readonly actions: readonly ConflictAction[],
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("Resolve conflict");
        this.contentEl.createEl("p", {
            text: this.conflict.path,
        });
        this.contentEl.createEl("p", {
            text: "The Server and this device have different changes. Choose the result you want to make authoritative.",
        });
        for (const action of this.actions) {
            new Setting(this.contentEl)
                .setName(action.label)
                .setDesc(action.description)
                .addButton((button) =>
                    button.setButtonText(action.label).onClick(() => {
                        void action.run().then(() => this.close());
                    }),
                );
        }
        new Setting(this.contentEl).addButton((button) =>
            button.setButtonText("Cancel").onClick(() => this.close()),
        );
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

class ConflictResolutionModal extends FuzzySuggestModal<RemoteConflict> {
    public constructor(
        app: App,
        private readonly conflicts: readonly RemoteConflict[],
        placeholder: string,
        private readonly choose: (conflict: RemoteConflict) => Promise<void>,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    public getItems(): RemoteConflict[] {
        return [...this.conflicts];
    }

    public getItemText(conflict: RemoteConflict): string {
        return `${conflict.path} ${conflictReason(conflict)}`;
    }

    public onChooseItem(conflict: RemoteConflict): void {
        void this.choose(conflict);
    }
}

class KeepBothDestinationModal extends Modal {
    private destinationPath: string;

    public constructor(
        app: App,
        sourcePath: string,
        private readonly choose: (destinationPath: string) => Promise<boolean>,
    ) {
        super(app);
        this.destinationPath = conflictCopyPath(sourcePath);
    }

    public onOpen(): void {
        this.setTitle("Keep both file versions");
        this.contentEl.createEl("p", {
            text: "Choose where to save this device's copy. The Server version remains at the original path.",
        });
        new Setting(this.contentEl)
            .setName("Local copy path")
            .setDesc("A new Vault-relative path for this device's version.")
            .addText((text) => {
                text.setValue(this.destinationPath)
                    .onChange((value) => {
                        this.destinationPath = value.trim();
                    })
                    .inputEl.select();
            });
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Keep both")
                    .setCta()
                    .onClick(() => {
                        void this.choose(this.destinationPath).then(
                            (resolved) => {
                                if (resolved) {
                                    this.close();
                                }
                            },
                        );
                    }),
            );
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

type MergePane = "CHANGES" | "RESULT";

const MERGE_PANES: readonly MergePane[] = ["CHANGES", "RESULT"];

function mergePaneName(pane: MergePane): string {
    switch (pane) {
        case "CHANGES":
            return "Changes";
        case "RESULT":
            return "Merged result";
    }
}

function mergeSourceActionName(source: ManualMergeSource): string {
    return source === "SERVER" ? "Server" : "this device";
}

class ManualMergeModal extends Modal {
    private activePane: MergePane = "CHANGES";

    private cancelButton: HTMLButtonElement | undefined;

    private result: HTMLTextAreaElement | undefined;

    private resultFeedback: HTMLElement | undefined;

    private readonly diff: ManualMergeDiff;

    private generatedResult = "";

    private readonly lineSelections = new Map<string, ManualMergeSource>();

    private readonly lineViews = new Map<string, HTMLElement>();

    private readonly lineSelectionIndicators = new Map<string, HTMLElement>();

    private mobileSelectedLineId: string | undefined;

    private mobileSelectedLineLabel: string | undefined;

    private mobileSelectionDescription: HTMLElement | undefined;

    private readonly mobileSelectionButtons = new Map<
        ManualMergeSource,
        HTMLButtonElement
    >();

    private saveButton: HTMLButtonElement | undefined;

    private saving = false;

    private readonly tabButtons = new Map<MergePane, HTMLButtonElement>();

    private workspace: HTMLElement | undefined;

    public constructor(
        app: App,
        private readonly path: string,
        private readonly serverContent: string,
        private readonly localContent: string,
        private readonly save: (mergedContent: string) => Promise<boolean>,
    ) {
        super(app);
        this.diff = createManualMergeDiff(serverContent, localContent);
        this.resetLineSelections("LOCAL");
    }

    public onOpen(): void {
        this.modalEl.classList.add("vaultdatum-merge-modal");
        this.modalEl.classList.toggle(
            "vaultdatum-merge-mobile-platform",
            Platform.isMobile,
        );
        this.contentEl.classList.add("vaultdatum-merge-content");
        this.setTitle("Resolve conflict");
        this.contentEl.createDiv({
            cls: "vaultdatum-merge-path",
            text: this.path,
        });
        this.contentEl.createEl("p", {
            cls: "vaultdatum-merge-introduction",
            text: "Choose the Server or this device for each change, then review the result to save. The Server remains authoritative until the new change is accepted.",
        });
        this.createTabs();
        this.createWorkspace();
        this.createActions();
        this.activatePane(this.activePane);
    }

    public onClose(): void {
        this.contentEl.empty();
        this.modalEl.classList.remove("vaultdatum-merge-modal");
        this.modalEl.classList.remove("vaultdatum-merge-mobile-platform");
        this.tabButtons.clear();
        this.workspace = undefined;
        this.result = undefined;
        this.resultFeedback = undefined;
        this.saveButton = undefined;
        this.cancelButton = undefined;
        this.lineViews.clear();
        this.lineSelectionIndicators.clear();
        this.mobileSelectedLineId = undefined;
        this.mobileSelectedLineLabel = undefined;
        this.mobileSelectionDescription = undefined;
        this.mobileSelectionButtons.clear();
    }

    private activatePane(pane: MergePane): void {
        this.activePane = pane;
        this.workspace?.setAttribute("data-active-pane", pane);
        for (const [tabPane, button] of this.tabButtons) {
            const active = tabPane === pane;
            button.setAttribute("aria-selected", String(active));
            button.tabIndex = active ? 0 : -1;
        }
    }

    private createActions(): void {
        const actions = this.contentEl.createDiv({
            cls: "vaultdatum-merge-actions",
        });
        this.cancelButton = actions.createEl("button", {
            text: "Cancel",
            attr: { type: "button" },
        });
        this.cancelButton.addEventListener("click", () => this.close());

        this.saveButton = actions.createEl("button", {
            cls: "mod-cta",
            text: "Save merged result",
            attr: { type: "button" },
        });
        this.saveButton.addEventListener("click", () => {
            void this.saveResult();
        });
    }

    private createResultPanel(workspace: HTMLElement): void {
        const panel = workspace.createDiv({
            cls: "vaultdatum-merge-panel vaultdatum-merge-result",
            attr: {
                "data-merge-pane": "RESULT",
                id: "vaultdatum-merge-result",
                role: "tabpanel",
                "aria-labelledby": "vaultdatum-merge-tab-result",
            },
        });
        panel.createEl("h3", { text: "Merged result" });
        this.resultFeedback = panel.createEl("p", {
            cls: "vaultdatum-merge-result-feedback",
            attr: { "aria-live": "polite" },
        });
        this.result = panel.createEl("textarea", {
            cls: "vaultdatum-merge-editor",
            attr: {
                "aria-label": "Merged result",
                rows: "16",
                spellcheck: "false",
            },
        });
        this.result.value = this.generatedResult;
        this.result.addEventListener("input", () => {
            this.updateResultFeedback();
        });
        this.updateResultFeedback();
    }

    private createChangesPanel(workspace: HTMLElement): void {
        const panel = workspace.createDiv({
            cls: "vaultdatum-merge-panel vaultdatum-merge-changes",
            attr: {
                "data-merge-pane": "CHANGES",
                id: "vaultdatum-merge-changes",
                role: "tabpanel",
                "aria-labelledby": "vaultdatum-merge-tab-changes",
            },
        });
        panel.createEl("h3", { text: "Line-by-line changes" });
        panel.createEl("p", {
            cls: "vaultdatum-merge-panel-description",
            text: "Each change starts with this device's version. On desktop, select the version you want to use. On mobile, select a line and then choose its version below.",
        });
        const allActions = panel.createDiv({
            cls: "vaultdatum-merge-all-actions",
        });
        this.createSourceSelectionButton(allActions, "SERVER");
        this.createSourceSelectionButton(allActions, "LOCAL");

        if (this.diff.limited) {
            panel.createEl("p", {
                cls: "vaultdatum-merge-diff-limit",
                text: "This comparison is too large to split safely. Choose a complete version or edit the result directly.",
            });
            const change = manualMergeChangeBlocks(this.diff)[0];
            if (change !== undefined) {
                this.createLimitedChangeBlock(panel, change);
            }
            return;
        }

        const headings = panel.createDiv({
            cls: "vaultdatum-merge-diff-headings",
        });
        headings.createDiv({ text: "Server version" });
        headings.createDiv({
            cls: "vaultdatum-merge-diff-heading-gutter",
            text: "Use",
        });
        headings.createDiv({ text: "This device's version" });

        let changeNumber = 0;
        for (const block of this.diff.blocks) {
            if (block.kind === "EQUAL") {
                this.createEqualBlock(
                    panel,
                    block.server.lines,
                    block.local.lines,
                );
                continue;
            }
            this.createChangeBlock(panel, block, ++changeNumber);
        }
        if (changeNumber === 0) {
            panel.createEl("p", {
                cls: "vaultdatum-merge-no-changes",
                text: "No line differences were found. You can still edit the merged result.",
            });
            return;
        }
        this.createMobileLineSelectionBar(panel);
    }

    private createChangeBlock(
        panel: HTMLElement,
        block: ManualMergeChangeBlock,
        changeNumber: number,
    ): void {
        const hunk = panel.createDiv({
            cls: "vaultdatum-merge-hunk",
        });
        const header = hunk.createDiv({
            cls: "vaultdatum-merge-hunk-header",
        });
        header.createSpan({ text: `Change ${changeNumber}` });
        header.createSpan({
            cls: "vaultdatum-merge-hunk-status",
            text: `${block.rows.length} line${block.rows.length === 1 ? "" : "s"}`,
        });
        for (const [index, row] of block.rows.entries()) {
            this.createLineChoiceBlock(
                hunk,
                row,
                `Change ${changeNumber}, line ${index + 1}`,
            );
        }
    }

    private createLineChoiceBlock(
        hunk: HTMLElement,
        row: ManualMergeChoiceRow,
        lineLabel: string,
    ): void {
        const lineChoice = hunk.createDiv({
            cls: "vaultdatum-merge-line-choice",
            attr: { "data-selected-source": this.selectedSource(row.id) },
        });
        this.lineViews.set(row.id, lineChoice);
        this.createChoiceDiffRows(lineChoice, row, lineLabel);
        this.updateLineSelection(row.id);
    }

    private createLimitedChangeBlock(
        panel: HTMLElement,
        block: ManualMergeChangeBlock,
    ): void {
        const row = block.rows[0];
        if (row === undefined) {
            return;
        }
        const hunk = panel.createDiv({
            cls: "vaultdatum-merge-hunk",
            attr: { "data-selected-source": this.selectedSource(row.id) },
        });
        const header = hunk.createDiv({
            cls: "vaultdatum-merge-hunk-header",
        });
        header.createSpan({ text: "Complete document" });
        this.lineViews.set(row.id, hunk);
        this.updateLineSelection(row.id);

        const previews = hunk.createDiv({
            cls: "vaultdatum-merge-source-previews",
        });
        this.createSourcePreview(previews, "SERVER", row.server.content);
        this.createSourcePreview(previews, "LOCAL", row.local.content);

        const actions = hunk.createDiv({
            cls: "vaultdatum-merge-hunk-actions",
        });
        this.createLineSelectionButton(actions, row.id, "SERVER");
        this.createLineSelectionButton(actions, row.id, "LOCAL");
    }

    private createSourcePreview(
        previews: HTMLElement,
        source: ManualMergeSource,
        content: string,
    ): void {
        const preview = previews.createDiv({
            cls: `vaultdatum-merge-source-preview vaultdatum-merge-preview-${source.toLowerCase()}`,
        });
        preview.createDiv({ text: `${mergeSourceActionName(source)} version` });
        const area = preview.createEl("textarea", {
            attr: {
                "aria-label": `${mergeSourceActionName(source)} version`,
                rows: "12",
                readonly: "true",
                spellcheck: "false",
            },
        });
        area.value = content;
    }

    private createDiffRows(
        container: HTMLElement,
        serverLines: readonly ManualMergeLine[],
        localLines: readonly ManualMergeLine[],
        kind: "CHANGE" | "EQUAL",
    ): void {
        const rows = container.createDiv({
            cls: `vaultdatum-merge-diff-rows vaultdatum-merge-diff-${kind.toLowerCase()}`,
        });
        this.createDiffColumn(rows, serverLines, "SERVER", kind);
        this.createDiffColumn(rows, localLines, "LOCAL", kind);
    }

    private createChoiceDiffRows(
        container: HTMLElement,
        row: ManualMergeChoiceRow,
        lineLabel: string,
    ): void {
        const rows = container.createDiv({
            cls: "vaultdatum-merge-diff-rows vaultdatum-merge-diff-change vaultdatum-merge-diff-choice",
        });
        this.createSelectableDiffColumn(
            rows,
            row.server.lines,
            "SERVER",
            row.id,
            lineLabel,
        );
        const gutter = rows.createDiv({
            cls: "vaultdatum-merge-line-gutter",
            attr: { "aria-hidden": "true" },
        });
        const indicator = gutter.createSpan({
            cls: "vaultdatum-merge-line-selection-indicator",
        });
        this.lineSelectionIndicators.set(row.id, indicator);
        this.createSelectableDiffColumn(
            rows,
            row.local.lines,
            "LOCAL",
            row.id,
            lineLabel,
        );
    }

    private createDiffColumn(
        container: HTMLElement,
        lines: readonly ManualMergeLine[],
        source: ManualMergeSource,
        kind: "CHANGE" | "EQUAL",
    ): void {
        const column = container.createDiv({
            cls: `vaultdatum-merge-diff-column vaultdatum-merge-diff-${source.toLowerCase()}`,
        });
        this.populateDiffColumn(column, lines, source, kind);
    }

    private createSelectableDiffColumn(
        container: HTMLElement,
        lines: readonly ManualMergeLine[],
        source: ManualMergeSource,
        lineId: string,
        lineLabel: string,
    ): void {
        const sourceName = mergeSourceActionName(source);
        const className = `vaultdatum-merge-diff-column vaultdatum-merge-diff-${source.toLowerCase()} vaultdatum-merge-selectable-source`;
        if (Platform.isMobile) {
            const column = container.createDiv({
                cls: className,
                attr: {
                    role: "button",
                    tabindex: "0",
                    "aria-label": `Select ${lineLabel}. ${sourceName} version is shown.`,
                },
            });
            const select = (): void => this.selectMobileLine(lineId, lineLabel);
            column.addEventListener("click", select);
            column.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                }
            });
            this.populateDiffColumn(column, lines, source, "CHANGE");
            return;
        }

        const column = container.createEl("button", {
            cls: className,
            attr: {
                type: "button",
                "data-merge-select-source": source,
                "aria-label": `Use ${sourceName} version for ${lineLabel}`,
                title: `Use ${sourceName} version for ${lineLabel}`,
            },
        });
        column.addEventListener("click", () => {
            this.requestLineSelection(lineId, source);
        });
        this.populateDiffColumn(column, lines, source, "CHANGE");
    }

    private populateDiffColumn(
        column: HTMLElement,
        lines: readonly ManualMergeLine[],
        source: ManualMergeSource,
        kind: "CHANGE" | "EQUAL",
    ): void {
        if (lines.length === 0) {
            column.createDiv({
                cls: "vaultdatum-merge-diff-empty",
                text: "No corresponding line",
            });
            return;
        }

        const marker = kind === "EQUAL" ? " " : source === "SERVER" ? "−" : "+";
        for (const line of lines) {
            const row = column.createDiv({ cls: "vaultdatum-merge-diff-line" });
            row.createSpan({
                cls: "vaultdatum-merge-diff-line-number",
                text: String(line.number),
            });
            row.createSpan({
                cls: "vaultdatum-merge-diff-marker",
                text: marker,
            });
            row.createSpan({
                cls: "vaultdatum-merge-diff-line-content",
                text: line.text.length === 0 ? " " : line.text,
            });
        }
    }

    private createEqualBlock(
        panel: HTMLElement,
        serverLines: readonly ManualMergeLine[],
        localLines: readonly ManualMergeLine[],
    ): void {
        const context = panel.createDiv({
            cls: "vaultdatum-merge-context",
        });
        this.createDiffRows(context, serverLines, localLines, "EQUAL");
    }

    private createLineSelectionButton(
        actions: HTMLElement,
        lineId: string,
        source: ManualMergeSource,
    ): void {
        const sourceName = mergeSourceActionName(source);
        const button = actions.createEl("button", {
            text: `Use ${sourceName}`,
            attr: { type: "button" },
        });
        button.addEventListener("click", () => {
            this.requestLineSelection(lineId, source);
        });
    }

    private createMobileLineSelectionBar(panel: HTMLElement): void {
        const bar = panel.createDiv({
            cls: "vaultdatum-merge-mobile-line-actions",
            attr: {
                role: "group",
                "aria-label": "Selected changed line",
            },
        });
        this.mobileSelectionDescription = bar.createDiv({
            cls: "vaultdatum-merge-mobile-line-description",
            attr: { "aria-live": "polite" },
        });
        const actions = bar.createDiv({
            cls: "vaultdatum-merge-mobile-line-action-buttons",
        });
        for (const source of ["SERVER", "LOCAL"] as const) {
            const sourceName = mergeSourceActionName(source);
            const button = actions.createEl("button", {
                text: `Use ${sourceName}`,
                attr: { type: "button" },
            });
            button.addEventListener("click", () => {
                if (this.mobileSelectedLineId !== undefined) {
                    this.requestLineSelection(
                        this.mobileSelectedLineId,
                        source,
                    );
                }
            });
            this.mobileSelectionButtons.set(source, button);
        }
        this.updateMobileLineSelectionBar();
    }

    private createSourceSelectionButton(
        actions: HTMLElement,
        source: ManualMergeSource,
    ): void {
        const sourceName = mergeSourceActionName(source);
        const button = actions.createEl("button", {
            text: `Use all from ${sourceName}`,
            attr: { type: "button" },
        });
        button.addEventListener("click", () => {
            this.requestSourceSelection(source);
        });
    }

    private createTabs(): void {
        const tabs = this.contentEl.createDiv({
            cls: "vaultdatum-merge-tabs",
            attr: { role: "tablist", "aria-label": "Manual merge panels" },
        });
        for (const pane of MERGE_PANES) {
            const button = tabs.createEl("button", {
                text: mergePaneName(pane),
                attr: {
                    type: "button",
                    id: `vaultdatum-merge-tab-${pane.toLowerCase()}`,
                    role: "tab",
                    "aria-controls": `vaultdatum-merge-${pane.toLowerCase()}`,
                },
            });
            button.addEventListener("click", () => this.activatePane(pane));
            button.addEventListener("keydown", (event) => {
                this.handleTabKeydown(event, pane);
            });
            this.tabButtons.set(pane, button);
        }
    }

    private createWorkspace(): void {
        this.workspace = this.contentEl.createDiv({
            cls: "vaultdatum-merge-workspace",
        });
        this.createChangesPanel(this.workspace);
        this.createResultPanel(this.workspace);
    }

    private handleTabKeydown(event: KeyboardEvent, pane: MergePane): void {
        const direction =
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (direction === 0) {
            return;
        }

        event.preventDefault();
        const currentIndex = MERGE_PANES.indexOf(pane);
        const nextIndex =
            (currentIndex + direction + MERGE_PANES.length) %
            MERGE_PANES.length;
        const nextPane = MERGE_PANES[nextIndex];
        this.activatePane(nextPane);
        this.tabButtons.get(nextPane)?.focus();
    }

    private hasCustomResult(): boolean {
        return this.result?.value !== this.generatedResult;
    }

    private requestLineSelection(
        lineId: string,
        source: ManualMergeSource,
    ): void {
        if (this.saving) {
            return;
        }
        const sourceName = mergeSourceActionName(source);
        this.requestGeneratedResultReplacement(
            `Use ${sourceName} for this line? Your unsaved result text will be replaced by a result rebuilt from the selected lines.`,
            `Use ${sourceName}`,
            () => {
                this.lineSelections.set(lineId, source);
                this.replaceResultWithSelections();
            },
        );
    }

    private requestSourceSelection(source: ManualMergeSource): void {
        if (this.saving) {
            return;
        }
        const sourceName = mergeSourceActionName(source);
        this.requestGeneratedResultReplacement(
            `Use all content from ${sourceName} as the result? Your unsaved result text will be replaced by that version.`,
            `Use all from ${sourceName}`,
            () => {
                this.resetLineSelections(source);
                this.replaceResultWithSelections(true);
            },
        );
    }

    private requestGeneratedResultReplacement(
        description: string,
        confirmLabel: string,
        replace: () => void,
    ): void {
        if (!this.hasCustomResult()) {
            replace();
            return;
        }

        new ReplaceManualMergeResultModal(
            this.app,
            description,
            confirmLabel,
            replace,
        ).open();
    }

    private replaceResultWithSelections(focusResult = false): void {
        const result = this.result;
        if (result === undefined) {
            return;
        }

        this.generatedResult = composeManualMergeResult(
            this.diff,
            this.lineSelections,
        );
        result.value = this.generatedResult;
        for (const line of manualMergeChoiceRows(this.diff)) {
            this.updateLineSelection(line.id);
        }
        this.updateResultFeedback();
        if (focusResult) {
            this.activatePane("RESULT");
            result.focus();
        }
    }

    private resetLineSelections(source: ManualMergeSource): void {
        this.lineSelections.clear();
        for (const line of manualMergeChoiceRows(this.diff)) {
            this.lineSelections.set(line.id, source);
        }
        this.generatedResult = composeManualMergeResult(
            this.diff,
            this.lineSelections,
        );
    }

    private selectedSource(lineId: string): ManualMergeSource {
        return this.lineSelections.get(lineId) ?? "LOCAL";
    }

    private selectMobileLine(lineId: string, lineLabel: string): void {
        if (this.saving || this.mobileSelectedLineId === lineId) {
            return;
        }
        this.lineViews
            .get(this.mobileSelectedLineId ?? "")
            ?.removeAttribute("data-mobile-selected");
        this.mobileSelectedLineId = lineId;
        this.mobileSelectedLineLabel = lineLabel;
        this.lineViews
            .get(lineId)
            ?.setAttribute("data-mobile-selected", "true");
        this.updateMobileLineSelectionBar();
    }

    private updateLineSelection(lineId: string): void {
        const source = this.selectedSource(lineId);
        this.lineViews
            .get(lineId)
            ?.setAttribute("data-selected-source", source);
        this.lineSelectionIndicators
            .get(lineId)
            ?.setText(source === "SERVER" ? "←" : "→");
        for (const candidate of ["SERVER", "LOCAL"] as const) {
            this.lineViews
                .get(lineId)
                ?.querySelector<HTMLButtonElement>(
                    `[data-merge-select-source="${candidate}"]`,
                )
                ?.setAttribute("aria-pressed", String(candidate === source));
        }
    }

    private updateMobileLineSelectionBar(): void {
        const hasSelectedLine = this.mobileSelectedLineId !== undefined;
        this.mobileSelectionDescription?.setText(
            hasSelectedLine
                ? `${this.mobileSelectedLineLabel ?? "Changed line"} selected. Choose a version to use.`
                : "Select a changed line to choose its version.",
        );
        for (const button of this.mobileSelectionButtons.values()) {
            button.toggleAttribute("disabled", this.saving || !hasSelectedLine);
        }
    }

    private async saveResult(): Promise<void> {
        const result = this.result;
        if (result === undefined || this.saving) {
            return;
        }

        this.saving = true;
        this.updateSaveControls();
        this.resultFeedback?.setText("Saving the merged result…");
        try {
            if (await this.save(result.value)) {
                this.close();
                return;
            }
        } catch {
            console.warn("VaultDatum manual merge save failed");
        }

        this.saving = false;
        this.updateSaveControls();
        this.resultFeedback?.setText(
            "Could not save the merged result. Neither source version was changed.",
        );
    }

    private updateResultFeedback(): void {
        if (this.saving) {
            return;
        }
        if (this.hasCustomResult()) {
            this.resultFeedback?.setText(
                "Custom result with unsaved edits. Choosing a change will rebuild this result.",
            );
            return;
        }
        const lines = manualMergeChoiceRows(this.diff);
        const serverChoiceCount = lines.filter(
            (line) => this.selectedSource(line.id) === "SERVER",
        ).length;
        if (serverChoiceCount === 0) {
            this.resultFeedback?.setText(
                "Result starts with this device's version.",
            );
            return;
        }
        this.resultFeedback?.setText(
            serverChoiceCount === lines.length
                ? "Result uses the Server version."
                : "Result combines selected Server and this device changes.",
        );
    }

    private updateSaveControls(): void {
        this.saveButton?.setText(
            this.saving ? "Saving…" : "Save merged result",
        );
        this.saveButton?.toggleAttribute("disabled", this.saving);
        this.cancelButton?.toggleAttribute("disabled", this.saving);
        this.updateMobileLineSelectionBar();
    }
}

class ReplaceManualMergeResultModal extends Modal {
    private confirmed = false;

    public constructor(
        app: App,
        private readonly description: string,
        private readonly confirmLabel: string,
        private readonly replace: () => void,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("Replace merged result?");
        this.contentEl.createEl("p", {
            text: this.description,
        });
        this.contentEl.createEl("p", {
            text: "Neither the Server version nor this device's version will be changed.",
        });
        new Setting(this.contentEl)
            .addButton((button) =>
                button
                    .setButtonText("Keep editing")
                    .onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText(this.confirmLabel)
                    .setWarning()
                    .onClick(() => {
                        if (this.confirmed) {
                            return;
                        }
                        this.confirmed = true;
                        this.replace();
                        this.close();
                    }),
            );
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

class VaultDatumSettingTab extends PluginSettingTab {
    private connectionFeedback: HTMLElement | undefined;

    private connectionStatusDescription: HTMLElement | undefined;

    private conflictDescription: HTMLElement | undefined;

    private initialSyncDescription: HTMLElement | undefined;

    private lastSyncDescription: HTMLElement | undefined;

    private lastResultDescription: HTMLElement | undefined;

    private pendingDescription: HTMLElement | undefined;

    private primaryAction: OverviewAction | undefined;

    private primaryActionButton: HTMLButtonElement | undefined;

    private resetButton: HTMLButtonElement | undefined;

    private resetConnectionButton: HTMLButtonElement | undefined;

    private resetDescription: HTMLElement | undefined;

    private reviewConflictsButton: HTMLButtonElement | undefined;

    private saveConnectionButton: HTMLButtonElement | undefined;

    private savingServerUrl = false;

    private serverUrlDraft = "";

    private serverUrlInput: HTMLInputElement | undefined;

    private vaultAccessTokenDraft = "";

    private vaultAccessTokenInput: HTMLInputElement | undefined;

    private vaultAccessTokenVisible = false;

    private serverTargetDescription: HTMLElement | undefined;

    private statusDescription: HTMLElement | undefined;

    private vaultIdentityDescription: HTMLElement | undefined;

    private refreshGeneration = 0;

    public constructor(
        app: App,
        private readonly plugin: VaultDatumPlugin,
    ) {
        super(app, plugin);
    }

    public display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.serverUrlDraft = this.plugin.serverUrl();
        this.vaultAccessTokenDraft = this.plugin.vaultAccessToken();
        this.vaultAccessTokenVisible = false;

        containerEl.createEl("h2", { text: "Server connection" });

        new Setting(containerEl)
            .setName("Server URL")
            .setDesc("Authoritative server address.")
            .addText((text) => {
                this.serverUrlInput = text.inputEl;
                text.setPlaceholder("https://vaultdatum.example")
                    .setValue(this.serverUrlDraft)
                    .onChange((value) => {
                        this.serverUrlDraft = value;
                        this.clearTokenForDifferentServerOrigin(value);
                        this.updateConnectionFeedback();
                        this.updateConnectionActions();
                    });
            });
        new Setting(containerEl)
            .setName("Vault access token")
            .setDesc(
                "Optional on a private network; required by a public Vault server.",
            )
            .addText((text) => {
                this.vaultAccessTokenInput = text.inputEl;
                text.inputEl.type = "password";
                text.setPlaceholder("vd1_…")
                    .setValue(this.vaultAccessTokenDraft)
                    .onChange((value) => {
                        this.vaultAccessTokenDraft = value;
                        this.updateConnectionActions();
                    });
            })
            .addButton((button) =>
                button.setButtonText("Show").onClick(() => {
                    this.vaultAccessTokenVisible =
                        !this.vaultAccessTokenVisible;
                    if (this.vaultAccessTokenInput !== undefined) {
                        this.vaultAccessTokenInput.type = this
                            .vaultAccessTokenVisible
                            ? "text"
                            : "password";
                    }
                    button.setButtonText(
                        this.vaultAccessTokenVisible ? "Hide" : "Show",
                    );
                }),
            );
        new Setting(containerEl)
            .setName("Test connection")
            .setDesc("Verify this URL without changing saved settings.")
            .addButton((button) =>
                button.setButtonText("Test connection").onClick(() => {
                    void this.testConnection();
                }),
            );
        new Setting(containerEl)
            .setName("Save and start sync")
            .setDesc("Save this address and begin automatic synchronization.")
            .addButton((button) => {
                this.saveConnectionButton = button.buttonEl;
                button.setCta().onClick(() => {
                    void this.saveServerUrl();
                });
            });
        new Setting(containerEl)
            .setName("Reset connection settings")
            .setDesc(
                "Clear the saved address and token; notes and sync tracking stay.",
            )
            .addButton((button) => {
                this.resetConnectionButton = button.buttonEl;
                button.setButtonText("Reset connection").onClick(() => {
                    this.requestResetConnectionSettings();
                });
            });
        this.connectionFeedback = containerEl.createEl("p", {
            cls: "setting-item-description",
        });
        this.updateConnectionFeedback();
        this.updateConnectionActions();

        containerEl.createEl("h2", { text: "Sync overview" });

        const synchronization = new Setting(containerEl)
            .setName("Current status")
            .setDesc(this.plugin.syncStatusDescription())
            .addButton((button) => {
                this.primaryActionButton = button.buttonEl;
                button.setCta().onClick(() => {
                    void this.runPrimaryAction();
                });
            });
        this.statusDescription = synchronization.descEl;
        if (this.primaryActionButton !== undefined) {
            this.primaryActionButton.disabled = true;
            this.primaryActionButton.textContent = "Loading…";
        }

        this.connectionStatusDescription = new Setting(containerEl)
            .setName("Connection")
            .setDesc("Checking connection state…").descEl;
        this.serverTargetDescription = new Setting(containerEl)
            .setName("Server URL")
            .setDesc("Not configured.").descEl;
        this.vaultIdentityDescription = new Setting(containerEl)
            .setName("Server Vault")
            .setDesc("Not verified yet.").descEl;

        this.lastSyncDescription = new Setting(containerEl)
            .setName("Last successful sync")
            .setDesc("Never").descEl;
        this.lastResultDescription = new Setting(containerEl)
            .setName("Last sync result")
            .setDesc("No sync has completed in this session yet.").descEl;
        this.pendingDescription = new Setting(containerEl)
            .setName("Local changes")
            .setDesc("Checking…").descEl;
        const conflicts = new Setting(containerEl)
            .setName("Conflicts")
            .setDesc("Checking…")
            .addButton((button) => {
                this.reviewConflictsButton = button.buttonEl;
                button.setButtonText("Review conflicts").onClick(() => {
                    void this.plugin.openConflictOverview();
                });
            });
        this.conflictDescription = conflicts.descEl;
        this.initialSyncDescription = new Setting(containerEl)
            .setName("First sync")
            .setDesc("Checking…").descEl;

        new Setting(containerEl)
            .setName("Automatic synchronization")
            .setDesc(
                "Local changes are recorded safely while sync is paused and will wait until you resume.",
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.isSyncEnabled())
                    .onChange((enabled) => {
                        void this.plugin.setSyncEnabled(enabled).then(() => {
                            this.refreshOverview();
                        });
                    });
            });

        containerEl.createEl("h3", { text: "Diagnostics and recovery" });
        new Setting(containerEl)
            .setName("Check all files")
            .setDesc(
                "Compare this device with a fresh server snapshot. Local changes are not discarded.",
            )
            .addButton((button) =>
                button.setButtonText("Check all files").onClick(() => {
                    void this.plugin.requestFullReconciliation();
                }),
            );
        const reset = new Setting(containerEl)
            .setName("Reset sync tracking")
            .setDesc(
                "Rebuild this device's sync tracking from the server. Notes and server files are not deleted.",
            )
            .addButton((button) => {
                this.resetButton = button.buttonEl;
                button.setButtonText("Reset sync tracking").onClick(() => {
                    void this.plugin.requestResetSyncTracking();
                });
            });
        this.resetDescription = reset.descEl;
        new Setting(containerEl)
            .setName("Diagnostic details")
            .setDesc(
                "Copy version and sync-state details without note content or access tokens.",
            )
            .addButton((button) =>
                button.setButtonText("Copy diagnostic details").onClick(() => {
                    void this.plugin.copyDiagnosticDetails();
                }),
            );

        this.refreshOverview();
    }

    public refreshOverview(): void {
        if (this.statusDescription !== undefined) {
            this.statusDescription.textContent =
                this.plugin.syncStatusDescription();
        }
        const generation = ++this.refreshGeneration;
        void this.plugin
            .syncOverview()
            .then((overview) => {
                if (
                    generation !== this.refreshGeneration ||
                    overview === undefined
                ) {
                    return;
                }
                this.renderOverview(overview);
            })
            .catch((error: unknown) =>
                console.warn(
                    "VaultDatum could not refresh sync overview",
                    error,
                ),
            );
    }

    private async testConnection(): Promise<void> {
        const result = await this.plugin.testServerConnection(
            this.serverUrlDraft,
            this.vaultAccessTokenDraft.trim(),
        );
        this.updateConnectionFeedback(result);
    }

    private async saveServerUrl(): Promise<void> {
        const normalized = normalizeServerUrl(this.serverUrlDraft);
        if (
            this.savingServerUrl ||
            normalized === undefined ||
            (normalized === this.plugin.serverUrl() &&
                this.vaultAccessTokenDraft.trim() ===
                    this.plugin.vaultAccessToken())
        ) {
            return;
        }

        this.savingServerUrl = true;
        this.updateConnectionActions();
        try {
            const result = await this.plugin.updateConnectionSettings(
                this.serverUrlDraft,
                this.vaultAccessTokenDraft,
            );
            this.updateConnectionFeedback(result);
            if (result.kind === "CONNECTED" && result.matchesCurrentVault) {
                new Notice(
                    "VaultDatum server URL saved. Synchronization started.",
                );
            }
        } finally {
            this.savingServerUrl = false;
            this.updateConnectionActions();
            this.refreshOverview();
        }
    }

    private requestResetConnectionSettings(): void {
        new ResetConnectionSettingsModal(this.app, async () => {
            const reset = await this.plugin.resetConnectionSettings();
            if (reset) {
                this.display();
            }
            return reset;
        }).open();
    }

    private updateConnectionFeedback(result?: ConnectionCheck): void {
        const feedback = this.connectionFeedback;
        if (feedback === undefined) {
            return;
        }
        if (result !== undefined) {
            feedback.textContent = connectionCheckDescription(result);
            return;
        }

        feedback.textContent = serverUrlHint(this.serverUrlDraft);
    }

    private clearTokenForDifferentServerOrigin(serverUrl: string): void {
        const savedOrigin = serverOrigin(this.plugin.serverUrl());
        const draftOrigin = serverOrigin(serverUrl);
        if (
            this.vaultAccessTokenDraft.length === 0 ||
            savedOrigin === undefined ||
            draftOrigin === undefined ||
            savedOrigin === draftOrigin
        ) {
            return;
        }

        this.vaultAccessTokenDraft = "";
        if (this.vaultAccessTokenInput !== undefined) {
            this.vaultAccessTokenInput.value = "";
        }
    }

    private updateConnectionActions(): void {
        const savedUrl = this.plugin.serverUrl();
        const draftUrl = normalizeServerUrl(this.serverUrlDraft);
        const savedToken = this.plugin.vaultAccessToken();
        const draftToken = this.vaultAccessTokenDraft.trim();
        const saveButton = this.saveConnectionButton;
        if (saveButton !== undefined) {
            const saved =
                draftUrl !== undefined &&
                draftUrl === savedUrl &&
                draftToken === savedToken &&
                savedUrl.length > 0;
            saveButton.disabled =
                this.savingServerUrl || draftUrl === undefined || saved;
            saveButton.textContent = this.savingServerUrl
                ? "Saving…"
                : saved
                  ? "Saved"
                  : "Save and start sync";
        }
        if (this.resetConnectionButton !== undefined) {
            this.resetConnectionButton.disabled =
                this.savingServerUrl || savedUrl.length === 0;
        }
    }

    private async runPrimaryAction(): Promise<void> {
        switch (this.primaryAction) {
            case "CONNECT":
            case "REVIEW_CONNECTION":
                this.serverUrlInput?.focus();
                return;
            case "UPDATE_TOKEN":
                this.vaultAccessTokenInput?.focus();
                return;
            case "RESUME":
                await this.plugin.setSyncEnabled(true);
                this.refreshOverview();
                return;
            case "RETRY":
            case "SYNC":
                await this.plugin.requestManualSync();
                return;
            case "REVIEW_CONFLICTS":
                await this.plugin.openConflictOverview();
                return;
            default:
                return;
        }
    }

    private updatePrimaryAction(status: SyncStatus): void {
        const button = this.primaryActionButton;
        if (button === undefined) {
            return;
        }

        const action = primaryOverviewAction(status);
        this.primaryAction = action;
        if (action === undefined) {
            button.disabled = true;
            button.textContent = "Syncing…";
            return;
        }

        button.disabled = false;
        button.textContent = primaryOverviewActionLabel(action);
    }

    private renderOverview(overview: SyncOverview): void {
        this.updatePrimaryAction(overview.status);
        if (this.connectionStatusDescription !== undefined) {
            this.connectionStatusDescription.textContent =
                connectionOverviewDescription(overview);
        }
        if (this.serverTargetDescription !== undefined) {
            this.serverTargetDescription.textContent =
                overview.serverUrl.length === 0
                    ? "Not configured."
                    : overview.serverUrl;
        }
        if (this.vaultIdentityDescription !== undefined) {
            this.vaultIdentityDescription.textContent =
                vaultIdentityDescription(overview);
        }
        if (this.lastSyncDescription !== undefined) {
            this.lastSyncDescription.textContent = formatLastSuccessfulSync(
                overview.status.lastSuccessfulAt,
            );
        }
        if (this.lastResultDescription !== undefined) {
            this.lastResultDescription.textContent = describeSyncResult(
                overview.status,
            );
        }
        if (this.pendingDescription !== undefined) {
            this.pendingDescription.textContent = describeCount(
                overview.activity.pendingCount,
                "local change",
                "local changes",
            );
        }
        if (this.conflictDescription !== undefined) {
            this.conflictDescription.textContent = describeCount(
                overview.activity.conflictCount,
                "conflict",
                "conflicts",
            );
        }
        if (this.reviewConflictsButton !== undefined) {
            this.reviewConflictsButton.disabled =
                overview.activity.conflictCount === 0;
        }
        if (this.initialSyncDescription !== undefined) {
            this.initialSyncDescription.textContent = overview.activity
                .initialBootstrapComplete
                ? overview.status.summary?.initialBootstrap === true
                    ? "Complete. The Server Vault was checked before local changes were classified."
                    : "Complete."
                : "The server will be checked before local-only files are queued.";
        }
        if (this.resetDescription !== undefined) {
            this.resetDescription.textContent = resetDescription(
                overview.resetEligibility,
            );
        }
        if (this.resetButton !== undefined) {
            this.resetButton.disabled = !overview.resetEligibility.eligible;
        }
        if (this.resetConnectionButton !== undefined) {
            this.resetConnectionButton.disabled =
                overview.serverUrl.length === 0;
        }
    }
}

class ResetSyncTrackingModal extends Modal {
    private confirmed = false;

    public constructor(
        app: App,
        private readonly confirmReset: () => Promise<void>,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("Reset sync tracking?");
        this.contentEl.createEl("p", {
            text: "This rebuilds this device's sync tracking from the server.",
        });
        this.contentEl.createEl("p", {
            text: "Your local notes and the server Vault will not be deleted or overwritten.",
        });
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Reset sync tracking")
                    .setWarning()
                    .onClick(() => {
                        if (this.confirmed) {
                            return;
                        }
                        this.confirmed = true;
                        void this.confirmReset().then(() => this.close());
                    }),
            );
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

class ResetConnectionSettingsModal extends Modal {
    private confirmed = false;

    public constructor(
        app: App,
        private readonly confirmReset: () => Promise<boolean>,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("Reset connection settings?");
        this.contentEl.createEl("p", {
            text: "This clears the saved Server URL and Vault access token. Notes and sync tracking stay unchanged.",
        });
        this.contentEl.createEl("p", {
            text: "Your local notes, sync tracking, and Server Vault will not be changed.",
        });
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Reset connection")
                    .setWarning()
                    .onClick(() => {
                        if (this.confirmed) {
                            return;
                        }
                        this.confirmed = true;
                        void this.confirmReset().then((reset) => {
                            if (reset) {
                                this.close();
                                return;
                            }
                            this.confirmed = false;
                        });
                    }),
            );
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

function readSettings(value: unknown): VaultDatumSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ...DEFAULT_SETTINGS };
    }

    const stored = value as Record<string, unknown>;
    return {
        serverUrl:
            typeof stored.serverUrl === "string"
                ? stored.serverUrl
                : DEFAULT_SETTINGS.serverUrl,
        vaultAccessToken:
            typeof stored.vaultAccessToken === "string"
                ? stored.vaultAccessToken
                : DEFAULT_SETTINGS.vaultAccessToken,
        databaseName:
            typeof stored.databaseName === "string"
                ? stored.databaseName
                : DEFAULT_SETTINGS.databaseName,
        syncEnabled:
            typeof stored.syncEnabled === "boolean"
                ? stored.syncEnabled
                : DEFAULT_SETTINGS.syncEnabled,
    };
}

function conflictCopyPath(path: string): string {
    const slash = path.lastIndexOf("/");
    const directory = slash === -1 ? "" : path.slice(0, slash + 1);
    const filename = path.slice(slash + 1);
    const extension = filename.lastIndexOf(".");

    if (extension <= 0) {
        return `${directory}${filename} (conflict copy)`;
    }

    return `${directory}${filename.slice(0, extension)} (conflict copy)${filename.slice(extension)}`;
}

function conflictReason(conflict: RemoteConflict): string {
    if (conflict.serverState.state === "DELETED") {
        return "The Server deleted this path while this device kept a version.";
    }
    if (conflict.code === "REMOTE_CONTENT_TOO_LARGE") {
        return "The Server file exceeds this device's synchronization size limit.";
    }
    if (conflict.code === "LOCAL_CONTENT_TOO_LARGE") {
        return "This device's file exceeds the synchronization size limit.";
    }
    return "The Server and this device have different changes.";
}

function normalizeServerUrl(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    try {
        const url = new URL(trimmed);
        if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username.length > 0 ||
            url.password.length > 0 ||
            url.search.length > 0 ||
            url.hash.length > 0
        ) {
            return undefined;
        }

        const path = url.pathname.replace(/\/+$/, "");
        return `${url.origin}${path}`;
    } catch {
        return undefined;
    }
}

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function serverOrigin(value: string): string | undefined {
    const normalized = normalizeServerUrl(value);
    if (normalized === undefined) {
        return undefined;
    }
    return new URL(normalized).origin;
}

function serverUrlHint(value: string): string {
    if (value.trim().length === 0) {
        return "Enter the complete URL of your VaultDatum server.";
    }
    const normalized = normalizeServerUrl(value);
    if (normalized === undefined) {
        return "Use a complete http:// or https:// URL without credentials or query parameters.";
    }
    if (normalized.startsWith("http://")) {
        return "HTTP is appropriate only on a protected private network, such as a WireGuard VPN.";
    }
    return "The connection will be checked when you test or save this URL.";
}

function connectionCheckDescription(result: ConnectionCheck): string {
    if (result.kind === "CONNECTED") {
        if (!result.matchesCurrentVault) {
            return "This Server belongs to a different Vault. Existing sync tracking was not changed.";
        }
        return `Connection successful. Vault ID: ${result.vault.vaultId}.`;
    }
    return result.message;
}

function formatLastSuccessfulSync(timestamp: string | undefined): string {
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

function primaryOverviewAction(status: SyncStatus): OverviewAction | undefined {
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
        return status.summary?.vaultMismatch === true
            ? "REVIEW_CONNECTION"
            : "RETRY";
    }
    if (status.kind === "CONFLICT") {
        return "REVIEW_CONFLICTS";
    }
    return "SYNC";
}

function primaryOverviewActionLabel(action: OverviewAction): string {
    if (action === "CONNECT") {
        return "Connect server";
    }
    if (action === "UPDATE_TOKEN") {
        return "Update access token";
    }
    if (action === "REVIEW_CONNECTION") {
        return "Review connection";
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

function connectionOverviewDescription(overview: SyncOverview): string {
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

function vaultIdentityDescription(overview: SyncOverview): string {
    if (overview.vaultId !== undefined) {
        return overview.vaultId;
    }
    if (overview.connectionCheck?.kind === "CONNECTED") {
        return overview.connectionCheck.vault.vaultId;
    }
    return "Not verified yet.";
}

function describeSyncResult(status: SyncStatus): string {
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

function describeCount(
    count: number,
    singular: string,
    plural: string,
): string {
    if (count === 0) {
        return `No ${plural}.`;
    }
    return `${count} ${count === 1 ? singular : plural}.`;
}

function resetDescription(eligibility: SyncTrackingResetEligibility): string {
    if (eligibility.eligible) {
        return "Ready to reset. Notes and server files will not be deleted.";
    }
    return resetBlockedMessage(eligibility);
}

function resetBlockedMessage(
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

function syncStatusLabel(status: SyncStatus): string {
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
        return status.summary?.vaultMismatch
            ? "VaultDatum: Different Vault"
            : "VaultDatum: Error";
    }
    if (status.kind === "PAUSED") {
        return "VaultDatum: Paused";
    }
    return "VaultDatum: Ready";
}

function syncStatusDescription(status: SyncStatus): string {
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
