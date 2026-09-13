# VaultDatum

VaultDatum converges local Obsidian Vaults with a single authoritative server
Vault while preserving local usability during offline work.

## Prerequisites

- Java 25
- Node.js 24 or later

The repository includes a Gradle wrapper; a system Gradle installation is not
required.

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

The initial health endpoint is available at `GET /health` on port 8080.

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

The named `vaultdatum-data` volume persists server data, including the SQLite
database. Back up this volume before an upgrade; do not use `docker compose down
-v` in production.

## Layout

- `protocol/`: OpenAPI wire contract shared by the server and client.
- `server/`: Quarkus authoritative-server application.
- `client/obsidian/`: Obsidian plugin.
- `compose.yaml`: Single-host example for the native OCI image.
