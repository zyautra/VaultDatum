# Contributing to VaultDatum

VaultDatum welcomes bug reports, documentation improvements, tests, and focused
code contributions. Please keep in mind that synchronization changes must
preserve offline operation, data integrity, and conflict safety.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- For a larger feature or a protocol change, open an issue first to agree on
  the problem and approach.
- For synchronization behavior, refer to the
  [product specification](https://github.com/zyautra/vaultdatum-docs/blob/main/00_product-specification.md).
  [`protocol/openapi.yaml`](./protocol/openapi.yaml) is the source of truth for
  HTTP payloads and protocol types.

## Reporting Issues

Use a clear title and include:

- VaultDatum version, operating system, and Obsidian version when relevant;
- concise reproduction steps, expected behavior, and actual behavior;
- sanitized logs, operation IDs, and error messages if available.

Never include note contents, access tokens, passwords, authorization headers,
or other sensitive data in an issue.

For a suspected security vulnerability, do not open a public issue. Contact
[zyautra@gmail.com](mailto:zyautra@gmail.com) instead.

## Pull Requests

- Create a focused `feature/*` branch from `main` for new functionality, and
  merge it only after the relevant checks pass.
- Keep each pull request focused on one problem.
- Add or update tests for behavior changes, particularly synchronization,
  persistence, conflict, and recovery behavior.
- Update documentation and the OpenAPI contract when the externally observable
  behavior or protocol changes.
- Run the relevant checks before requesting review:

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

Describe the problem, solution, verification performed, and any known
limitations in the pull request.

## Licensing Contributions

By submitting a pull request, you confirm that you have the right to submit
the contribution and license it under the
[GNU Affero General Public License v3.0 or later](./LICENSE). No contributor
license agreement or DCO sign-off is currently required.
