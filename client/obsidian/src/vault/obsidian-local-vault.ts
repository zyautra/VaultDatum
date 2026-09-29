import { App, TFile, TFolder } from "obsidian";
import { type LocalVault } from "../sync/remote-apply";

export class ObsidianLocalVault implements LocalVault {
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
