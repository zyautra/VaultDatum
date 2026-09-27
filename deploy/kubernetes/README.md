# Kubernetes deployment configuration

`base/` is intentionally portable. It creates a non-root Server Pod, one
`ReadWriteOnce` PVC, and a private `ClusterIP` Service, but it does not select a
namespace, image registry, host path, node, private network range, or runtime
UID/GID.

For hostPath, local volumes, or bind-mounted storage, create the deployment
overlay in an access-controlled repository. Provision the Host data directory
before the Pod starts, using a dedicated `vaultdatum` service account. The
overlay must use that account's numeric UID/GID consistently for
`runAsUser`, `runAsGroup`, and (where the storage driver needs it) `fsGroup`.
Do not use a personal login account or the image fallback UID as the Host data
owner.

The following illustrates the identity portion of a private deployment patch.
`4242` is an example only; replace every value with the dedicated service
account's actual numeric UID/GID before applying it.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vaultdatum-server
spec:
  template:
    spec:
      securityContext:
        fsGroup: 4242
        fsGroupChangePolicy: OnRootMismatch
        runAsGroup: 4242
        runAsNonRoot: true
        runAsUser: 4242
```

For a new Host directory, stop the Server and provision ownership before the
first deployment. For an existing data root, back up the full `/data` tree
including SQLite WAL files, stop the single Server writer, migrate its owner,
then update the private overlay and verify `/health/ready` after rollout.

The Server can create Vault content as owner-only files. Read those files with
the dedicated service account or privileged operational access rather than
making every Host user a reader.

## Public access profile

`base/` is deliberately private by default. A public deployment belongs in a
separate access-controlled overlay because its Gateway name, namespace labels,
certificate reference, hostname, and NetworkPolicy selectors are cluster
configuration, not portable product configuration.

The public overlay must set `VAULTDATUM_ACCESS_PROFILE=public-token`, mount an
existing Kubernetes Secret at `/run/secrets/vaultdatum`, and set
`VAULTDATUM_AUTH_TOKEN_FILE=/run/secrets/vaultdatum/access-token`. The Secret
uses an `access-token` key whose value is one `vd1_`-prefixed 256-bit random
token. Do not use `secretGenerator` from a checked-in plaintext file and do
not put the Secret, hostname, or certificate material in this repository.

Expose only the `ClusterIP` Service through an HTTPS/WSS Gateway route whose
certificate covers the exact public hostname. Do not route public traffic to
port 8080 directly or expose `/health`, the PVC, or SQLite. The target
namespace must be explicitly accepted by the Gateway, and its NetworkPolicy
must permit the Gateway data-plane pods while denying other ingress. Rate
limits and request-header redaction are Gateway policy requirements; in
particular, do not log `Authorization` or `Sec-WebSocket-Protocol` values.

After replacing the Secret, restart the single Server Pod and verify that the
old token receives `401` while a client configured with the new token can read
Vault metadata. Rotation invalidates all existing realtime tickets and
connections, but pending client changes remain durable.
