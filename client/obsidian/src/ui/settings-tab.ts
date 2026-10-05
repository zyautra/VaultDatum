import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { type SyncStatus } from "../sync/sync-scheduler";
import {
    type ConnectionCheck,
    type SyncOverview,
    type OverviewAction,
    connectionCheckDescription,
    formatLastSuccessfulSync,
    primaryOverviewAction,
    primaryOverviewActionLabel,
    connectionOverviewDescription,
    vaultIdentityDescription,
    describeSyncResult,
    describeCount,
    resetDescription,
} from "./sync-status";
import type VaultDatumPlugin from "../main";
import { normalizeServerUrl, serverOrigin, serverUrlHint } from "../settings";

export class VaultDatumSettingTab extends PluginSettingTab {
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
            case "RECONNECT_RESTORED":
                await this.plugin.requestReconnectRestoredVault();
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

export class ResetSyncTrackingModal extends Modal {
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

export class ReconnectRestoredVaultModal extends Modal {
    private confirmed = false;

    public constructor(
        app: App,
        private readonly pendingCount: number,
        private readonly conflictCount: number,
        private readonly confirmReconnect: () => Promise<void>,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("Reconnect to restored server Vault?");
        this.contentEl.createEl("p", {
            text: "The server Vault was restored from a backup. This device's sync tracking belongs to the Vault before the restore and will be rebuilt.",
        });
        this.contentEl.createEl("p", {
            text: "Your local files are not changed. Files created or edited after the backup are sent again or kept as conflicts; nothing is overwritten.",
        });
        this.contentEl.createEl("p", {
            text: "Files deleted after the backup come back from the server. A rename that was not sent yet may leave both the old and the new file.",
        });
        if (this.pendingCount > 0 || this.conflictCount > 0) {
            this.contentEl.createEl("p", {
                text: `${this.pendingCount} pending change(s) and ${this.conflictCount} conflict(s) recorded for the previous Vault will be classified again from your local files.`,
            });
        }
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Reconnect")
                    .setWarning()
                    .onClick(() => {
                        if (this.confirmed) {
                            return;
                        }
                        this.confirmed = true;
                        void this.confirmReconnect().then(() => this.close());
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
