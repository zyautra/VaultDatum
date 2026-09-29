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
npm --prefix client/obsidian run test
npm --prefix client/obsidian run lint
npm --prefix client/obsidian run format:check
npm --prefix client/obsidian run build
```

## Run the Server in Development

```bash
./gradlew :server:quarkusDev
```

The health endpoint is available at `GET /health` on port 8080. The server also
exposes `GET /api/v1/vault` and `POST /api/v1/operations` for multipart file
`CREATE`/`MODIFY` and JSON file or empty-directory `CREATE`/`DELETE`/
`RENAME`/`MOVE` requests.

The server durably records a mutation as `PREPARED` before changing the Vault
filesystem. Startup recovery completes prepared file and empty-directory
CREATE, MODIFY, DELETE, RENAME, and MOVE operations whether their filesystem
effect had not yet occurred or had already occurred before SQLite finalization.
A committed operation is idempotently replayed if its response was lost.

## Current Sync Slice

The Obsidian plugin's settings tab is the **Sync overview**. It keeps a Server
URL draft locally while the user types, then offers **Test connection** and
**Save and start sync**. A reachable server with a different Vault identity is
never adopted automatically; an unavailable URL may still be saved for an
offline or VPN-reconnect workflow. The optional **Vault access token** is used
only with an `https://` URL. A public server returns a distinct authentication
state when the token is missing or rotated; pending work stays local and is not
retried automatically until the connection settings change. A private-network
hint is shown only while editing an `http://` URL.

After the plugin has started, a new, modified, deleted, renamed, or moved file
outside `.obsidian/` is captured as a durable operation before it is eligible
for upload. Empty directories are also captured and applied as first-class
entries; non-empty directories are never implicitly renamed or deleted
recursively. Local events, plugin startup, app foregrounding, network recovery,
server notifications, and retry timers all schedule a serialized sync cycle. A
trigger that arrives during a cycle causes one follow-up cycle, so **Sync now**
is an optional manual retry rather than a requirement for normal
synchronization. Automatic synchronization can be paused without losing local
changes. The status bar and settings overview report `Connect server`, `First
sync`, `Syncing`, `Up to date`, `Pending`, `Offline`, `Authentication required`,
`Conflict`, `Error`, or `Paused`, together with the last successful sync time
and pending/conflict counts. MODIFY and DELETE retain
the last replicated revision and content hash as their base condition. A
same-directory path change is a RENAME; a change of parent directory is a MOVE.
Both use a PRESENT source base and an UNKNOWN destination base, then commit both
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
known server deletion. On an initial connection, it first integrates a fresh
server manifest. Existing server paths are downloaded or recorded as replicas;
divergent and tombstoned paths become conflicts without overwriting local
content. Only paths confirmed as server `UNKNOWN` become durable file or empty
directory CREATE candidates. Existing durable operations are first matched
against the change journal by operation ID so a lost response is not mistaken
for an initial-import conflict. The **Full reconciliation** command compares
local state and the replica index with a fresh server manifest; the same
manifest recovery runs automatically when the incremental journal is no longer
available.

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
`/api/v1/notifications`. A `public-token` server first issues a short-lived,
single-use ticket through authenticated HTTP; the browser sends that ticket
only as a WebSocket subprotocol, never in the URL. A `REVISION_ADVANCED`
message contains only the latest revision and schedules an ordinary pull-based
sync; it never carries Vault content or becomes a correctness dependency.
Lost, duplicated, or delayed notifications therefore do not change
synchronization results.

An initial import never automatically restores a locally recreated tombstoned
path. RENAME and MOVE changes are applied only when both source and destination
paths are safe; a divergent local source or destination becomes a durable
conflict and neither remote effect overwrites local content. The
**Resolve conflict: use Server** command lets a user
explicitly replace one conflicted local file with the latest Server version.
**Resolve conflict: apply Local** turns a conflicted local file into a new
MODIFY operation against that latest Server version. **Resolve conflict: keep
Deleted** turns an already-deleted local file into a new DELETE operation
against the latest Server file. **Resolve conflict: restore Local** creates an
explicit restore operation only when the latest Server state is a deleted
tombstone. **Resolve conflict: keep Both** keeps the Server file at its
original path and queues this device's content as a new file at a user-selected
path. **Resolve conflict: merge manually** presents a color-coded, line-by-line
Server and local Markdown comparison alongside a distinct editable result. Each
changed line starts with this device's version and can explicitly select either
side, including mixed choices within one changed block; on narrow screens, the
comparison and result are available through tabs. The user-edited result is
queued as a new MODIFY operation.

The overview offers **Check all files**, conflict review, and redacted
diagnostic copying. **Reset sync tracking** is available only when no pending
or recovery work remains; it preserves both Vaults and local notes while
rebuilding this device's replica and cursor state through server-first
bootstrap. **Reset connection settings** only removes the saved Server URL,
Vault access token, and pause preference; it does not clear sync tracking or
local files.

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

The Compose image has a non-root fallback identity, but a host-backed bind
mount should use a dedicated Host `vaultdatum` service account instead. Set
`VAULTDATUM_RUNTIME_UID` and `VAULTDATUM_RUNTIME_GID` to that account's numeric
identity through an ignored `.env` file; [`.env.example`](./.env.example) lists
the optional variables. Provision the mount owner before startup. Do not use a
personal login account, and do not rely on the fallback UID matching a Host
user.

## Server Vault Write Boundary

The server Vault is modified only through the Sync API. Do not edit, copy, or
delete files in the server `vault` directory directly, and do not open it as an
editor workspace. After startup recovery the server runs a detect-only
integrity scan and logs each difference as `external_drift_detected`; it never
imports, reverts, or overwrites drift. A client mutation on a drifted path is
rejected as `503 RECOVERY_REQUIRED` before anything is prepared, while other
paths keep synchronizing. Resolve drift by restoring the recorded content, or
by moving the edited content out of the Vault, restoring the recorded state,
and submitting it again through a client.

### Migrate an Existing Vault

To move an existing Vault from other storage, copy its files once into the
`vault` directory of a new, empty data root and start the server with
`VAULTDATUM_INITIAL_IMPORT=true`. Leave out `.obsidian/`, `.git/`, and every
other name that starts with `.`, symbolic links, and files larger than
`VAULTDATUM_MAX_CONTENT_BYTES`. The server then records every regular file and
empty directory as a `SERVER_EXTERNAL` CREATE in one transaction. If any entry
cannot be imported, or the Vault directory is empty, startup fails, the log
lists each rejected path as `initial_import_rejected`, and nothing is recorded.
Once `initial_import_complete` is logged, unset the flag and restart. The server
refuses to start with the flag set after the journal has any change.

## Deploy on Kubernetes

`deploy/kubernetes/base` is portable: it makes no assumptions about a
namespace, node, storage path, container registry, service exposure, or private
network ranges. It deploys one `Recreate` replica, a `ReadWriteOnce` 20 Gi PVC,
and a `ClusterIP` Service. A cluster with a default dynamic StorageClass can
provision the PVC directly. Every host-backed or permission-sensitive volume
also needs a private runtime-identity overlay. For static storage, supply the
cluster-specific PV, PVC binding, and runtime identity there.

Build and publish the native OCI image to the registry selected for the target
cluster:

```bash
./gradlew :server:build \
  -Dquarkus.native.enabled=true \
  -Dquarkus.native.container-build=true \
  -Dquarkus.native.container-runtime=docker \
  -Dquarkus.package.jar.enabled=false \
  --no-daemon
docker build -f server/src/main/docker/Dockerfile.native \
  --build-arg APP_VERSION=0.5.0 \
  -t registry.example.com/vaultdatum/server:0.5.0 server
docker push registry.example.com/vaultdatum/server:0.5.0
```

Create an organization-specific overlay outside source control (or use a
separately access-controlled deployment repository). It chooses the namespace,
image, storage class, ingress or gateway, NetworkPolicy, and—only where needed—a
static PV. Do not put host paths, node names, private CIDRs, registry
credentials, or other installation-specific values in this repository.

For example, an overlay's `kustomization.yaml` can set the namespace and image:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: vaultdatum
resources:
  - ../../base
images:
  - name: vaultdatum-server
    newName: registry.example.com/vaultdatum/server
    newTag: "0.5.0"
```

The public base intentionally does not set a fixed runtime UID/GID. In a
host-backed deployment, use the dedicated Host service account's numeric
identity in the private overlay and provision `/data` with the same owner. See
[the Kubernetes deployment guide](./deploy/kubernetes/README.md). A local
`internal-local` overlay is ignored by Git because node names, storage paths,
private network ranges, and runtime identity are installation configuration.

Apply the overlay and wait for the one authoritative server Pod:

```bash
kubectl apply -k /secure/deployment-config/vaultdatum
kubectl -n vaultdatum rollout status deployment/vaultdatum-server
```

`private-network` is the default access profile. Keep its Service private and
restrict it with the target environment's NetworkPolicy and firewall. A public
deployment is supported only with `public-token`: a TLS-terminating Gateway,
an HTTPS-only client URL, and a Vault token stored outside Git in a read-only
Secret volume. The public Gateway must route only HTTPS/WSS traffic to the
ClusterIP Service; do not publish port 8080, `/health`, the PVC, or SQLite.

The private deployment overlay supplies the Secret and configuration without
putting the token plaintext in source control:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vaultdatum-server
spec:
  template:
    spec:
      securityContext:
        fsGroup: 4242 # example; use the deployment's runtime GID
      containers:
        - name: server
          env:
            - name: VAULTDATUM_ACCESS_PROFILE
              value: public-token
            - name: VAULTDATUM_AUTH_TOKEN_FILE
              value: /run/secrets/vaultdatum/access-token
          volumeMounts:
            - name: vault-access-token
              mountPath: /run/secrets/vaultdatum
              readOnly: true
      volumes:
        - name: vault-access-token
          secret:
            secretName: vaultdatum-public-access-token
            defaultMode: 0440
```

The Secret value is one `vd1_`-prefixed 256-bit random token under the
`access-token` key. Give the public URL and token to each device through a
private channel. To rotate it, replace the Secret, restart the one server Pod,
then enter the new token on every client. The old token and all outstanding
realtime tickets immediately stop working after restart. Follow the full
public Gateway, TLS, NetworkPolicy, and logging requirements in the [security
and deployment guide](https://github.com/zyautra/vaultdatum-docs/blob/main/09_security-and-deployment.md).
Back up the entire `/data` PVC, including SQLite WAL files and the Vault, using
a crash-consistent volume snapshot or a planned maintenance window.

## Layout

- `protocol/`: OpenAPI wire contract shared by the server and client.
- `server/`: Quarkus authoritative-server application.
- `client/obsidian/`: Obsidian plugin.
- `compose.yaml`: Single-host example for the native OCI image.
- `deploy/kubernetes/`: Kustomize manifests for a single authoritative server.
