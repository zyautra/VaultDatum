import {
    App,
    type ButtonComponent,
    FuzzySuggestModal,
    Modal,
    Setting,
} from "obsidian";

import { createManualMergeDiff } from "../core/manual-merge-diff";
import type {
    HistoryContentResult,
    ReadResult,
    RemoteHistoryEntry,
    RemoteHistoryPage,
} from "../transport/server-client";

const IMAGE_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
]);

export interface FileHistoryController {
    readonly path: string;
    readonly ownClientId: string;
    load(before?: number): Promise<ReadResult<RemoteHistoryPage>>;
    readCurrent(): Promise<ArrayBuffer | undefined>;
    download(entry: RemoteHistoryEntry): Promise<HistoryContentResult>;
    restore(entry: RemoteHistoryEntry): Promise<void>;
}

/**
 * Lists the versions of one file and restores a selected version after confirmation.
 */
export class FileHistoryModal extends Modal {
    private readonly entries: RemoteHistoryEntry[] = [];

    private selected: RemoteHistoryEntry | undefined;

    private hasMore = false;

    private listEl: HTMLElement | undefined;

    private previewEl: HTMLElement | undefined;

    private restoreButton: ButtonComponent | undefined;

    private previewUrl: string | undefined;

    public constructor(
        app: App,
        private readonly controller: FileHistoryController,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("File history");
        this.modalEl.addClass("vaultdatum-file-history");
        this.contentEl.createDiv({
            cls: "vaultdatum-file-history-path",
            text: this.controller.path,
        });

        const body = this.contentEl.createDiv({
            cls: "vaultdatum-file-history-body",
        });
        this.listEl = body.createDiv({
            cls: "vaultdatum-file-history-list",
            attr: { role: "listbox", "aria-label": "Versions" },
        });
        this.previewEl = body.createDiv({
            cls: "vaultdatum-file-history-preview",
        });
        this.previewEl.setText("Choose a version to preview it.");

        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Close").onClick(() => this.close()),
            )
            .addButton((button) => {
                this.restoreButton = button;
                button
                    .setButtonText("Restore this version")
                    .setCta()
                    .setDisabled(true)
                    .onClick(() => this.confirmRestore());
            });

        void this.loadPage();
    }

    public onClose(): void {
        this.releasePreviewUrl();
        this.contentEl.empty();
    }

    private async loadPage(): Promise<void> {
        const before = this.hasMore ? this.entries.at(-1)?.revision : undefined;
        let result: ReadResult<RemoteHistoryPage>;

        try {
            result = await this.controller.load(before);
        } catch {
            this.showListMessage("VaultDatum could not read the file history.");
            return;
        }
        if (result.kind !== "OK") {
            this.showListMessage(
                "File history is available when VaultDatum is connected.",
            );
            return;
        }

        this.entries.push(...result.value.entries);
        this.hasMore = result.value.hasMore;
        this.renderList();
    }

    private renderList(): void {
        const list = this.listEl;
        if (list === undefined) {
            return;
        }

        list.empty();
        if (this.entries.length === 0) {
            list.setText("VaultDatum has no history for this file.");
            return;
        }

        this.entries.forEach((entry, index) => {
            const current = index === 0;
            const restorable = !current && isRestorable(entry);
            const item = list.createEl("button", {
                cls: "vaultdatum-file-history-entry",
                attr: {
                    role: "option",
                    "aria-selected": String(entry === this.selected),
                },
            });
            item.toggleClass("is-selected", entry === this.selected);
            item.toggleClass("is-unavailable", !current && !restorable);
            item.createDiv({
                cls: "vaultdatum-file-history-time",
                text: current
                    ? `Current version · ${formatTime(entry.committedAt)}`
                    : formatTime(entry.committedAt),
            });
            item.createDiv({
                cls: "vaultdatum-file-history-detail",
                text: entryDescription(entry, this.controller.ownClientId),
            });
            item.addEventListener("click", () => {
                void this.select(entry, current);
            });
        });

        if (this.hasMore) {
            const more = list.createEl("button", {
                cls: "vaultdatum-file-history-more",
                text: "Show older versions",
            });
            more.addEventListener("click", () => {
                void this.loadPage();
            });
        }
    }

    private async select(
        entry: RemoteHistoryEntry,
        current: boolean,
    ): Promise<void> {
        this.selected = entry;
        this.renderList();
        this.restoreButton?.setDisabled(current || !isRestorable(entry));

        const preview = this.previewEl;
        if (preview === undefined) {
            return;
        }
        this.releasePreviewUrl();
        preview.empty();

        if (entry.state === "DELETED") {
            preview.setText(
                "This file was deleted here. Choose an earlier version to restore it.",
            );
            return;
        }
        if (!entry.contentAvailable) {
            preview.setText("The content of this version is no longer kept.");
            return;
        }

        preview.setText("Loading…");
        let content: HistoryContentResult;
        try {
            content = await this.controller.download(entry);
        } catch {
            preview.setText("VaultDatum could not load this version.");
            return;
        }
        if (this.selected !== entry) {
            return;
        }
        if (content.kind !== "OK") {
            preview.setText(
                content.kind === "CONTENT_NOT_RETAINED"
                    ? "The content of this version is no longer kept."
                    : "File history is available when VaultDatum is connected.",
            );
            return;
        }

        preview.empty();
        await this.renderPreview(preview, entry, content.value, current);
    }

    private async renderPreview(
        preview: HTMLElement,
        entry: RemoteHistoryEntry,
        content: ArrayBuffer,
        current: boolean,
    ): Promise<void> {
        const extension = fileExtension(this.controller.path);

        if (extension === "md") {
            const selectedText = new TextDecoder().decode(content);
            const currentContent = current
                ? content
                : await this.controller.readCurrent();
            if (currentContent === undefined) {
                preview.createEl("pre", { text: selectedText });
                return;
            }
            renderDiff(
                preview,
                new TextDecoder().decode(currentContent),
                selectedText,
            );
            return;
        }
        if (IMAGE_EXTENSIONS.has(extension)) {
            this.previewUrl = URL.createObjectURL(new Blob([content]));
            preview.createEl("img", {
                attr: { src: this.previewUrl, alt: this.controller.path },
            });
            return;
        }

        preview.setText(
            `${extension.length === 0 ? "File" : extension.toUpperCase()} · ${formatSize(entry.size ?? content.byteLength)}`,
        );
    }

    private confirmRestore(): void {
        const entry = this.selected;
        if (entry === undefined || !isRestorable(entry)) {
            return;
        }

        new ConfirmRestoreModal(
            this.app,
            this.controller.path,
            formatTime(entry.committedAt),
            () => {
                this.close();
                void this.controller.restore(entry);
            },
        ).open();
    }

    private showListMessage(message: string): void {
        this.listEl?.setText(message);
        this.previewEl?.empty();
    }

    private releasePreviewUrl(): void {
        if (this.previewUrl !== undefined) {
            URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = undefined;
        }
    }
}

class ConfirmRestoreModal extends Modal {
    public constructor(
        app: App,
        private readonly path: string,
        private readonly versionTime: string,
        private readonly confirm: () => void,
    ) {
        super(app);
    }

    public onOpen(): void {
        this.setTitle("Restore this version?");
        this.contentEl.createEl("p", {
            text: `${this.path} will be changed to the version from ${this.versionTime}.`,
        });
        this.contentEl.createEl("p", {
            text: "The current version stays in File history, so you can restore it again.",
        });
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Restore")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.confirm();
                    }),
            );
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Lets the user pick a deleted file whose history should be opened.
 */
export class DeletedFilePickerModal extends FuzzySuggestModal<string> {
    public constructor(
        app: App,
        private readonly paths: readonly string[],
        private readonly choose: (path: string) => void,
    ) {
        super(app);
        this.setPlaceholder("Choose a deleted file to restore");
    }

    public getItems(): string[] {
        return [...this.paths];
    }

    public getItemText(path: string): string {
        return path;
    }

    public onChooseItem(path: string): void {
        this.choose(path);
    }
}

function renderDiff(
    container: HTMLElement,
    currentText: string,
    selectedText: string,
): void {
    const diff = createManualMergeDiff(currentText, selectedText);
    container.createDiv({
        cls: "vaultdatum-file-history-diff-caption",
        text: "Changes from the current version",
    });
    const lines = container.createDiv({ cls: "vaultdatum-file-history-diff" });

    for (const block of diff.blocks) {
        if (block.kind === "EQUAL") {
            for (const line of block.local.lines) {
                diffLine(lines, " ", line.number, line.text, "is-equal");
            }
            continue;
        }
        for (const line of block.server.lines) {
            diffLine(lines, "-", line.number, line.text, "is-removed");
        }
        for (const line of block.local.lines) {
            diffLine(lines, "+", line.number, line.text, "is-added");
        }
    }
}

function diffLine(
    container: HTMLElement,
    marker: string,
    number: number,
    text: string,
    cls: string,
): void {
    const row = container.createDiv({
        cls: `vaultdatum-file-history-diff-line ${cls}`,
    });
    row.createSpan({
        cls: "vaultdatum-file-history-diff-number",
        text: String(number),
    });
    row.createSpan({
        cls: "vaultdatum-file-history-diff-marker",
        text: marker,
    });
    row.createSpan({ text });
}

function isRestorable(entry: RemoteHistoryEntry): boolean {
    return entry.state === "PRESENT" && entry.contentAvailable;
}

function entryDescription(
    entry: RemoteHistoryEntry,
    ownClientId: string,
): string {
    const change = changeLabel(entry);
    const device =
        entry.actor.type === "CLIENT"
            ? entry.actor.clientId === ownClientId
                ? "This device"
                : "Another device"
            : "Server import";
    const availability =
        entry.state === "PRESENT" && !entry.contentAvailable
            ? " · Content no longer kept"
            : "";
    return `${change} · ${device}${availability}`;
}

function changeLabel(entry: RemoteHistoryEntry): string {
    switch (entry.type) {
        case "CREATE":
            return entry.actor.type === "SERVER_EXTERNAL"
                ? "Imported"
                : "Created";
        case "MODIFY":
            return "Edited";
        case "DELETE":
            return "Deleted";
        case "RENAME":
            return entry.previousPath === undefined
                ? "Renamed"
                : `Renamed from ${entry.previousPath}`;
        case "MOVE":
            return entry.previousPath === undefined
                ? "Moved"
                : `Moved from ${entry.previousPath}`;
    }
}

function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? timestamp
        : date.toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
          });
}

function formatSize(size: number): string {
    if (size < 1024) {
        return `${size} B`;
    }
    if (size < 1024 * 1024) {
        return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
