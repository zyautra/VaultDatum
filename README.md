# VaultDatum

VaultDatum converges local Obsidian Vaults with a single authoritative server
Vault while preserving local usability during offline work.

## Prerequisites

- Java 25
- Node.js 24 or later

The repository includes a Gradle wrapper; a system Gradle installation is not
required.

Server builds run jOOQ code generation automatically from the versioned SQLite
migrations. Generated sources are build output and are never edited or
committed; run `./gradlew :server:jooqCodegen` when you need to inspect them.

## Validate the Initial Setup

```bash
./gradlew test
npm --prefix protocol ci
npm --prefix client/obsidian install
npm --prefix client/obsidian run protocol:check
npm --prefix client/obsidian run check
npm --prefix client/obsidian run lint
npm --prefix client/obsidian run format:check
npm --prefix client/obsidian run build
```

## Run the Server in Development

```bash
./gradlew :server:quarkusDev
```

The health endpoint is available at `GET /health` on port 8080. The server also
exposes `GET /api/v1/vault` and `POST /api/v1/operations` for multipart
`CREATE`/`MODIFY` and JSON `DELETE`/`RENAME` requests.

The server durably records a mutation as `PREPARED` before changing the Vault
filesystem. Startup recovery completes prepared CREATE, MODIFY, DELETE, and
RENAME operations whether their filesystem effect had not yet occurred or had
already occurred before SQLite finalization. A committed operation is
idempotently replayed if its response was lost.

## Current Sync Slice

The Obsidian plugin has a **Server URL** setting. After the plugin has started,
a new, modified, deleted, or renamed file outside `.obsidian/` is captured as
a durable operation before it is eligible for upload. MODIFY and DELETE retain
the last replicated revision and content hash as their base condition. RENAME
uses a PRESENT source base and an UNKNOWN destination base, then commits both
path effects at one server revision. The same stored snapshot and operation ID
are retried after an interrupted request or a plugin restart. A server commit
removes a local content artifact, but retains a lightweight committed operation
marker until its own change-journal entry is observed. A conflict remains
durable and is not silently overwritten.

The client pulls the server change journal before and after pushing. It stores
the server cursor, per-path replica state, conflicts, and remote-apply intents
in IndexedDB. A client with no cursor and no stored operations first creates a
short-lived server manifest, materializes its present files through conditional
`GET /api/v1/content`, records deleted tombstones, and advances to the manifest
snapshot cursor. It then pulls later journal changes normally. When a page
contains several revisions for one path, it applies the final state rather than
asking the server for content that is no longer current. Existing divergent
local content becomes a conflict; it is never overwritten.

The client also performs a local integrity scan to recover missed file events.
It compares file hashes against the replica index, durably queues missed local
modifications and deletions, and quarantines a file that reappears after a
known server deletion. Files already present when synchronization is first set
up are retained as an untracked baseline rather than uploaded automatically.
The **Full reconciliation** command compares that local state and replica index
with a fresh server manifest; the same manifest recovery runs automatically
when the incremental journal is no longer available.

Before replacing a local file, a client records a prepared apply intent and
stores the verified remote bytes as a temporary IndexedDB artifact. On restart,
it finalizes an already-applied result, resumes a staged safe write, discards an
unstaged intent for a later retry, or preserves an unexpected local state as a
conflict.

Images, PDFs, and other regular files use the same raw binary multipart upload
and conditional binary download path as notes; no file content is encoded in
JSON. The current client transport uses bounded `ArrayBuffer` transfers, so a
single synchronized file is limited to 8 MiB. The client checks file metadata
before reading an oversized file, and the server independently rejects it with
`413 CONTENT_TOO_LARGE`.

The plugin also keeps a best-effort WebSocket connection to
`/api/v1/notifications`. A `REVISION_ADVANCED` message contains only the
latest revision and schedules an ordinary pull-based sync; it never carries
Vault content or becomes a correctness dependency. Lost, duplicated, or
delayed notifications therefore do not change synchronization results.

This slice does not yet import an existing Vault, synchronize MOVE operations,
or restore a locally recreated tombstoned path. RENAME changes are applied only
when both source and destination paths are safe; a divergent local source or
destination becomes a durable conflict and neither remote effect overwrites
local content. The **Resolve conflict: use Server** command lets a user
explicitly replace one conflicted local file with the latest Server version.
**Resolve conflict: apply Local** turns a conflicted local file into a new
MODIFY operation against that latest Server version. **Resolve conflict: keep
Deleted** turns an already-deleted local file into a new DELETE operation
against the latest Server file. **Resolve conflict: restore Local** creates an
explicit restore operation only when the latest Server state is a deleted
tombstone. **Resolve conflict: keep Both** keeps the Server file at its
original path and queues this device's content as a new file at a user-selected
path. **Resolve conflict: merge manually** shows the Server and local Markdown
versions, then queues the user-edited result as a new MODIFY operation.

## Update Client Protocol Types

The OpenAPI document is the wire-contract source of truth. Regenerate the
checked-in TypeScript types after changing it:

```bash
npm --prefix client/obsidian run protocol:generate
```

## Build the Native OCI Image

Production packaging is a Linux native executable in a UBI 9-compatible OCI
image. The image can be deployed with Docker Compose, Kubernetes, or another
OCI-compatible platform. Build the native executable first:

```bash
./gradlew :server:build \
  -Dquarkus.native.enabled=true \
  -Dquarkus.native.container-build=true \
  -Dquarkus.native.container-runtime=docker \
  -Dquarkus.package.jar.enabled=false \
  --no-daemon
```

## Run with Docker Compose

`compose.yaml` is a single-host deployment example, not a requirement for
production. It builds the native OCI image and starts the server with a
persistent data volume:

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health
```

The named `vaultdatum-data` volume persists the server data root, including the
authoritative Vault, SQLite metadata, staging, and recovery directories. Back
up this volume before an upgrade; do not use `docker compose down -v` in
production. For Docker, Kubernetes, or another OCI platform, mount persistent
storage at `/data`.

## Layout

- `protocol/`: OpenAPI wire contract shared by the server and client.
- `server/`: Quarkus authoritative-server application.
- `client/obsidian/`: Obsidian plugin.
- `compose.yaml`: Single-host example for the native OCI image.
