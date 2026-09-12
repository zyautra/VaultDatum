import { Notice, Plugin } from "obsidian";

export default class VaultDatumPlugin extends Plugin {
    public async onload(): Promise<void> {
        this.addCommand({
            id: "sync-now",
            name: "Sync now",
            callback: () => {
                new Notice("VaultDatum synchronization is not configured yet.");
            },
        });
    }
}
