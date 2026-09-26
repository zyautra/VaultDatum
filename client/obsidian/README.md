# VaultDatum for Obsidian

## Development

```bash
npm install
npm run check
npm run build
```

For watch mode, run `npm run dev`. Link this directory into an Obsidian Vault's
`.obsidian/plugins/vaultdatum` directory, then reload the plugin in Obsidian.

For a manual installation, copy `main.js`, `manifest.json`, and `styles.css`
into that plugin directory before reloading the plugin.

`main.js` is a generated build artifact and is intentionally not committed.
