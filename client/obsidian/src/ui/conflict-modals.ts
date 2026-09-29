import {
    App,
    FuzzySuggestModal,
    Modal,
    Setting,
    type FuzzyMatch,
} from "obsidian";
import { type RemoteConflict } from "../storage/client-store";

export interface ConflictAction {
    readonly label: string;
    readonly description: string;
    readonly run: () => Promise<void>;
}

export class ConflictOverviewModal extends FuzzySuggestModal<RemoteConflict> {
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

export class ConflictActionModal extends Modal {
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

export class ConflictResolutionModal extends FuzzySuggestModal<RemoteConflict> {
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

export class KeepBothDestinationModal extends Modal {
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
