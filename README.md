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
exposes `GET /api/v1/vault` and the first mutation endpoint,
`POST /api/v1/operations` for multipart `CREATE` requests.

## Current Sync Slice

The Obsidian plugin has a **Server URL** setting. After the plugin has started,
a newly created file outside `.obsidian/` is read as binary data, hashed, and
stored with a pending CREATE record in IndexedDB before it is eligible for
upload. The same stored snapshot and operation ID are retried after an
interrupted request or a plugin restart. A server commit removes the local
artifact, but retains a lightweight committed operation marker until its own
change-journal entry is observed. A conflict remains durable and is not
silently overwritten.

The client pulls the server change journal before and after pushing. It stores
the server cursor, per-path replica state, conflicts, and remote-apply intents
in IndexedDB. A second empty client therefore downloads a server-created file
through `GET /api/v1/changes` and conditional `GET /api/v1/content`. Existing
local content at the same path becomes a conflict; it is never overwritten.

This slice deliberately supports only newly observed `CREATE` operations and
remote application of server-created files. It does not yet import an existing
Vault, synchronize local modify/delete/rename/move operations, or offer a
conflict-resolution UI.

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
