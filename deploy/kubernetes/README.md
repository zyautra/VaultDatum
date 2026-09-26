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
