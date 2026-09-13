import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from "obsidian";

import { ClientStore } from "./storage/client-store";
import { CreateSync, type SyncSummary } from "./sync/create-sync";
import type { LocalVault } from "./sync/remote-apply";
import { ServerClient } from "./transport/server-client";

interface VaultDatumSettings {
    serverUrl: string;
    databaseName: string;
}

const DEFAULT_SETTINGS: VaultDatumSettings = {
    serverUrl: "",
    databaseName: "",
};

export default class VaultDatumPlugin extends Plugin {
    private syncSettings: VaultDatumSettings = { ...DEFAULT_SETTINGS };

    private store: ClientStore | undefined;

    private createSync: CreateSync | undefined;

    private captureQueue: Promise<void> = Promise.resolve();

    public async onload(): Promise<void> {
        await this.loadSettings();
        this.store = await ClientStore.open(this.syncSettings.databaseName);
        this.createSync = new CreateSync(
            this.store,
            new ServerClient(),
            new ObsidianLocalVault(this.app),
            () => this.serverUrl(),
        );
        this.addSettingTab(new VaultDatumSettingTab(this.app, this));
        this.addCommand({
            id: "sync-now",
            name: "Sync now",
            callback: () => {
                void this.syncNow(true);
            },
        });

        this.app.workspace.onLayoutReady(() => {
            this.observeNewFiles();
            void this.syncNow(false);
        });
    }

    public onunload(): void {
        this.store?.close();
    }

    public async updateServerUrl(serverUrl: string): Promise<void> {
        this.syncSettings.serverUrl = serverUrl.trim();
        await this.saveSettings();
        void this.syncNow(false);
    }

    public serverUrl(): string {
        return this.syncSettings.serverUrl.replace(/\/+$/, "");
    }

    private observeNewFiles(): void {
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
                    this.captureCreatedFile(createSync, file),
                );
            }),
        );
    }

    private async captureCreatedFile(
        createSync: CreateSync,
        file: TFile,
    ): Promise<void> {
        try {
            const content = await this.app.vault.readBinary(file);
            const pending = await createSync.captureCreate(file.path, content);

            if (pending !== undefined) {
                void this.syncNow(false);
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

    private async syncNow(showResult: boolean): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            const summary = await createSync.sync();

            if (showResult) {
                this.showSyncResult(summary);
            }
        } catch {
            console.warn("VaultDatum synchronization failed");
            if (showResult) {
                new Notice(
                    "VaultDatum synchronization could not complete. Pending work is kept locally.",
                );
            }
        }
    }

    private showSyncResult(summary: SyncSummary): void {
        if (summary.vaultMismatch) {
            new Notice(
                "VaultDatum stopped because this local sync state belongs to another server Vault.",
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

class VaultDatumSettingTab extends PluginSettingTab {
    public constructor(
        app: App,
        private readonly plugin: VaultDatumPlugin,
    ) {
        super(app, plugin);
    }

    public display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Server URL")
            .setDesc("The HTTPS URL of the authoritative VaultDatum server.")
            .addText((text) => {
                text.setPlaceholder("https://vaultdatum.example")
                    .setValue(this.plugin.serverUrl())
                    .onChange(async (value) => {
                        await this.plugin.updateServerUrl(value);
                    });
            });
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
        databaseName:
            typeof stored.databaseName === "string"
                ? stored.databaseName
                : DEFAULT_SETTINGS.databaseName,
    };
}
