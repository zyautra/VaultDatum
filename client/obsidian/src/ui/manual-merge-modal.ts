import { App, Modal, Platform, Setting } from "obsidian";
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
} from "../core/manual-merge-diff";

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

export class ManualMergeModal extends Modal {
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
