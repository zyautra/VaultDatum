import {
    App,
    FuzzySuggestModal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from "obsidian";

import { ClientStore, type RemoteConflict } from "./storage/client-store";
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

        this.app.workspace.onLayoutReady(() => {
            this.observeVaultChanges();
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
                if (!(file instanceof TFile)) {
                    return;
                }

                this.captureQueue = this.captureQueue.then(() =>
                    this.captureDeletedFile(createSync, file.path),
                );
            }),
        );
    }

    private async captureContentChange(
        createSync: CreateSync,
        file: TFile,
    ): Promise<void> {
        try {
            const content = await this.app.vault.readBinary(file);
            const pending = await createSync.captureModify(file.path, content);

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

    private async captureDeletedFile(
        createSync: CreateSync,
        path: string,
    ): Promise<void> {
        try {
            const pending = await createSync.captureDelete(path);

            if (pending !== undefined) {
                void this.syncNow(false);
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
            (conflict) => this.resolveUseServer(conflict),
        ).open();
    }

    private async resolveUseServer(conflict: RemoteConflict): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            if (await createSync.resolveUseServer(conflict.path)) {
                new Notice(
                    `VaultDatum replaced ${conflict.path} with the Server version.`,
                );
                void this.syncNow(false);
                return;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
        } catch {
            console.warn("VaultDatum could not apply the Server version");
            new Notice(
                "VaultDatum could not apply the Server version. The conflict was kept.",
            );
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
            (conflict) => this.resolveApplyLocal(conflict),
        ).open();
    }

    private async resolveApplyLocal(conflict: RemoteConflict): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            if (await createSync.resolveApplyLocal(conflict.path)) {
                new Notice(
                    `VaultDatum queued ${conflict.path} as a new local change.`,
                );
                void this.syncNow(false);
                return;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
        } catch {
            console.warn("VaultDatum could not prepare the local version");
            new Notice(
                "VaultDatum could not apply the local version. The conflict was kept.",
            );
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
            (conflict) => this.resolveKeepDeleted(conflict),
        ).open();
    }

    private async resolveKeepDeleted(conflict: RemoteConflict): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            if (await createSync.resolveKeepDeleted(conflict.path)) {
                new Notice(`VaultDatum queued deletion of ${conflict.path}.`);
                void this.syncNow(false);
                return;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
        } catch {
            console.warn("VaultDatum could not prepare the local deletion");
            new Notice(
                "VaultDatum could not keep that deletion. The conflict was kept.",
            );
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
        return `${conflict.path} (${conflict.code})`;
    }

    public onChooseItem(conflict: RemoteConflict): void {
        void this.choose(conflict);
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
