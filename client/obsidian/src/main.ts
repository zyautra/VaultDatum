import {
    App,
    FuzzySuggestModal,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from "obsidian";

import {
    exceedsSyncContentLimit,
    MAX_SYNC_CONTENT_BYTES,
} from "./core/content-limits";
import { ClientStore, type RemoteConflict } from "./storage/client-store";
import { CreateSync, type SyncSummary } from "./sync/create-sync";
import { NotificationChannel } from "./sync/notification-channel";
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

    private notificationChannel: NotificationChannel | undefined;

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
        this.notificationChannel = new NotificationChannel(
            () => this.serverUrl(),
            () => {
                void this.syncNow(false);
            },
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
            this.notificationChannel?.start();
            void this.syncNow(false);
        });
    }

    public onunload(): void {
        this.notificationChannel?.stop();
        this.store?.close();
    }

    public async updateServerUrl(serverUrl: string): Promise<void> {
        this.syncSettings.serverUrl = serverUrl.trim();
        await this.saveSettings();
        this.notificationChannel?.restart();
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
            void this.syncNow(false);
            return;
        }

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
                void this.syncNow(false);
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
                void this.syncNow(false);
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
                void this.syncNow(false);
            }
        } catch {
            console.warn("VaultDatum could not queue a renamed directory");
            new Notice(
                "VaultDatum could not queue a renamed directory. The local directory was not changed.",
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

    private async fullReconcile(showResult: boolean): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            const summary = await createSync.fullReconcile();

            if (showResult) {
                this.showSyncResult(summary);
            }
        } catch {
            console.warn("VaultDatum full reconciliation failed");
            if (showResult) {
                new Notice(
                    "VaultDatum could not complete full reconciliation. Pending work is kept locally.",
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
            (conflict) => this.resolveRestoreLocal(conflict),
        ).open();
    }

    private async resolveRestoreLocal(conflict: RemoteConflict): Promise<void> {
        const createSync = this.createSync;

        if (createSync === undefined) {
            return;
        }

        try {
            if (await createSync.resolveRestoreLocal(conflict.path)) {
                new Notice(
                    `VaultDatum queued restoration of ${conflict.path}.`,
                );
                void this.syncNow(false);
                return;
            }

            new Notice("VaultDatum could not find that conflict anymore.");
        } catch {
            console.warn("VaultDatum could not prepare the local restoration");
            new Notice(
                "VaultDatum could not restore that file. The conflict was kept.",
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
            (conflict) => this.openKeepBothDestination(conflict),
        ).open();
    }

    private async openKeepBothDestination(
        conflict: RemoteConflict,
    ): Promise<void> {
        new KeepBothDestinationModal(
            this.app,
            conflict.path,
            (destinationPath) =>
                this.resolveKeepBoth(conflict, destinationPath),
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
                (merged) => this.resolveManualMerge(conflict, merged),
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

class ManualMergeModal extends Modal {
    public constructor(
        app: App,
        private readonly path: string,
        private readonly serverContent: string,
        private readonly localContent: string,
        private readonly save: (mergedContent: string) => Promise<boolean>,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle(`Merge ${this.path}`);
        this.contentEl.createEl("p", {
            text: "Review both versions, then edit the merged result. The Server version stays authoritative until the new change is committed.",
        });
        this.readOnlyArea("Server version", this.serverContent);
        this.readOnlyArea("This device's version", this.localContent);
        const result = this.editableArea("Merged result", this.localContent);
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Save merged result")
                    .setCta()
                    .onClick(() => {
                        void this.save(result.value).then((saved) => {
                            if (saved) {
                                this.close();
                            }
                        });
                    }),
            );
    }

    public onClose(): void {
        this.contentEl.empty();
    }

    private readOnlyArea(label: string, value: string): void {
        const area = this.contentEl.createEl("textarea", {
            attr: { "aria-label": label, rows: "10", readonly: "true" },
        });
        area.value = value;
    }

    private editableArea(label: string, value: string): HTMLTextAreaElement {
        const area = this.contentEl.createEl("textarea", {
            attr: { "aria-label": label, rows: "12" },
        });
        area.value = value;
        return area;
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
