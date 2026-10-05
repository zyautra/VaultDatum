import { Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import {
    exceedsSyncContentLimit,
    MAX_SYNC_CONTENT_BYTES,
} from "./core/content-limits";
import { ClientStore, type RemoteConflict } from "./storage/client-store";
import { CreateSync, type SyncSummary } from "./sync/create-sync";
import { FileRestore, type RestoreOutcome } from "./sync/file-restore";
import { NotificationChannel } from "./sync/notification-channel";
import {
    SyncScheduler,
    SyncNotConfiguredError,
    SyncPausedError,
    type SyncActivity,
    type SyncStatus,
} from "./sync/sync-scheduler";
import { ServerAuthenticationError } from "./transport/access-token";
import {
    ServerClient,
    type RemoteHistoryEntry,
} from "./transport/server-client";
import {
    type VaultDatumSettings,
    DEFAULT_SETTINGS,
    readSettings,
    normalizeServerUrl,
    isHttpsUrl,
} from "./settings";
import {
    type ConnectionCheck,
    type SyncOverview,
    resetBlockedMessage,
    syncStatusLabel,
    syncStatusDescription,
} from "./ui/sync-status";
import { ObsidianLocalVault } from "./vault/obsidian-local-vault";
import {
    type ConflictAction,
    ConflictOverviewModal,
    ConflictActionModal,
    ConflictResolutionModal,
    KeepBothDestinationModal,
} from "./ui/conflict-modals";
import {
    DeletedFilePickerModal,
    FileHistoryModal,
    type FileHistoryController,
} from "./ui/file-history-modal";
import { ManualMergeModal } from "./ui/manual-merge-modal";
import {
    VaultDatumSettingTab,
    ReconnectRestoredVaultModal,
    ResetSyncTrackingModal,
} from "./ui/settings-tab";

export default class VaultDatumPlugin extends Plugin {
    private syncSettings: VaultDatumSettings = { ...DEFAULT_SETTINGS };

    private readonly serverClient = new ServerClient(() =>
        this.vaultAccessToken(),
    );

    private store: ClientStore | undefined;

    private createSync: CreateSync | undefined;

    private fileRestore: FileRestore | undefined;

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
        const localVault = new ObsidianLocalVault(this.app);
        const createSync = new CreateSync(
            this.store,
            this.serverClient,
            localVault,
            () => this.serverUrl(),
        );
        this.createSync = createSync;
        this.fileRestore = new FileRestore(
            this.store,
            this.serverClient,
            localVault,
            () => this.serverUrl(),
            (path, content) => createSync.captureModify(path, content),
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
            id: "reconnect-restored-vault",
            name: "Reconnect to restored server Vault",
            callback: () => {
                void this.requestReconnectRestoredVault();
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
            id: "show-file-history",
            name: "Show file history",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (file === null) {
                    return false;
                }
                if (!checking) {
                    void this.openFileHistory(file.path);
                }
                return true;
            },
        });
        this.addCommand({
            id: "restore-deleted-file",
            name: "Restore deleted file",
            callback: () => {
                void this.openDeletedFilePicker();
            },
        });
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (file instanceof TFile) {
                    menu.addItem((item) =>
                        item
                            .setTitle("File history")
                            .setIcon("history")
                            .onClick(() => {
                                void this.openFileHistory(file.path);
                            }),
                    );
                }
            }),
        );
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

    public async requestReconnectRestoredVault(): Promise<void> {
        const store = this.store;
        const scheduler = this.syncScheduler;
        if (store === undefined || scheduler === undefined) {
            return;
        }
        if (this.syncStatus?.summary?.vaultRestored !== true) {
            new Notice(
                "VaultDatum has not detected a restored server Vault. Run Sync now first.",
            );
            return;
        }
        if (scheduler.isBusy()) {
            new Notice(
                "Wait for the current synchronization to finish before reconnecting.",
            );
            return;
        }

        await this.captureQueue;
        const eligibility = await store.resetEligibility();
        new ReconnectRestoredVaultModal(
            this.app,
            eligibility.pendingCount,
            eligibility.conflictCount,
            async () => {
                await this.reconnectRestoredVault();
            },
        ).open();
    }

    private async reconnectRestoredVault(): Promise<void> {
        const createSync = this.createSync;
        const scheduler = this.syncScheduler;
        if (createSync === undefined || scheduler === undefined) {
            return;
        }

        this.resetInProgress = true;
        this.notificationChannel?.stop();
        scheduler.refreshAvailability();
        let reconnected = false;
        try {
            await this.captureQueue;
            const outcome = await createSync.reconnectToRestoredVault();
            reconnected = outcome.kind === "RECONNECTED";
            new Notice(reconnectOutcomeMessage(outcome.kind));
        } catch (error: unknown) {
            console.warn(
                "VaultDatum could not reconnect to the restored Vault",
                error,
            );
            new Notice(
                "VaultDatum could not reconnect to the restored Vault. Your files were not changed.",
            );
        } finally {
            this.resetInProgress = false;
        }

        if (reconnected) {
            this.lastPersistedSuccessfulAt = undefined;
        }
        if (this.syncSettings.syncEnabled) {
            this.notificationChannel?.restart();
            scheduler.refreshAvailability();
            void this.syncNow(false);
        } else {
            scheduler.refreshAvailability();
        }
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

    private async openFileHistory(path: string): Promise<void> {
        const store = this.store;
        const fileRestore = this.fileRestore;

        if (store === undefined || fileRestore === undefined) {
            return;
        }
        if (this.serverUrl().length === 0) {
            new Notice("Configure a Server URL before opening file history.");
            return;
        }

        const localVault = new ObsidianLocalVault(this.app);
        const controller: FileHistoryController = {
            path,
            ownClientId: await store.clientId(),
            load: (before) => fileRestore.history(path, before),
            readCurrent: () => localVault.readFile(path),
            download: (entry) =>
                entry.contentHash === undefined
                    ? Promise.resolve({ kind: "CONTENT_NOT_RETAINED" })
                    : this.serverClient.downloadHistoryContent(
                          this.serverUrl(),
                          entry.contentHash,
                      ),
            restore: (entry) => this.restoreFileVersion(path, entry),
        };
        new FileHistoryModal(this.app, controller).open();
    }

    private async openDeletedFilePicker(): Promise<void> {
        const store = this.store;

        if (store === undefined) {
            return;
        }

        const deleted = (await store.replicas())
            .filter(
                (entry) =>
                    entry.entryType === "FILE" && entry.state === "DELETED",
            )
            .map((entry) => entry.path)
            .sort((left, right) => left.localeCompare(right));
        if (deleted.length === 0) {
            new Notice("VaultDatum has no deleted files to restore.");
            return;
        }

        new DeletedFilePickerModal(this.app, deleted, (path) => {
            void this.openFileHistory(path);
        }).open();
    }

    private async restoreFileVersion(
        path: string,
        entry: RemoteHistoryEntry,
    ): Promise<void> {
        const fileRestore = this.fileRestore;

        if (fileRestore === undefined) {
            return;
        }

        try {
            const outcome = await fileRestore.restore(path, entry);
            new Notice(restoreOutcomeMessage(path, outcome));
            if (outcome.kind === "QUEUED") {
                void this.syncNow(false);
            }
        } catch {
            console.warn("VaultDatum could not restore a file version");
            new Notice(
                `VaultDatum could not restore ${path}. The file was not changed.`,
            );
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
        if (summary.vaultRestored === true) {
            new Notice(
                'VaultDatum stopped because the server Vault was restored from a backup. Run "Reconnect to restored server Vault" to continue.',
            );
            return;
        }
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

function maximumContentSizeLabel(): string {
    return `${MAX_SYNC_CONTENT_BYTES / (1024 * 1024)} MiB`;
}

function restoreOutcomeMessage(path: string, outcome: RestoreOutcome): string {
    switch (outcome.kind) {
        case "QUEUED":
            return `VaultDatum queued restoration of ${path}.`;
        case "UNAVAILABLE":
            return "File history is available when VaultDatum is connected.";
        case "NOT_RETAINED":
            return "That version is no longer kept.";
        case "BLOCKED":
            switch (outcome.reason) {
                case "CONFLICT":
                    return `Resolve the conflict for ${path} first.`;
                case "PENDING":
                case "OUT_OF_SYNC":
                    return `Sync ${path} first, then restore the version.`;
                case "PATH_OCCUPIED":
                    return `A file already exists at ${path}.`;
                case "UNKNOWN_PATH":
                    return `VaultDatum does not track ${path} yet.`;
                case "TOO_LARGE":
                    return "That version exceeds the attachment size limit.";
                case "ALREADY_CURRENT":
                    return "That is already the current version.";
            }
    }
}

function reconnectOutcomeMessage(
    kind: "RECONNECTED" | "NOT_RESTORED" | "UNAVAILABLE" | "BUSY",
): string {
    switch (kind) {
        case "RECONNECTED":
            return "VaultDatum reconnected to the restored server Vault. Your files were not changed; they will be compared with the server now.";
        case "NOT_RESTORED":
            return "The server Vault was not restored from this device's Vault. Sync tracking was not changed.";
        case "UNAVAILABLE":
            return "The server is unavailable. Try reconnecting again later.";
        case "BUSY":
            return "Wait for the current synchronization to finish before reconnecting.";
    }
}
