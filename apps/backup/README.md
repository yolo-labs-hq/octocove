# Backup tooling

Dependency-free Node ≥20 mirror snapshots, retention and restore drills. See [operator guide](../../docs/BACKUP.md) for recovery policy and deployment limits.

[deploy/cronjob.yaml](deploy/cronjob.yaml) is an example Kubernetes deployment,
with placeholder registry/image and operator-owned secrets. Adapt it to your own
cluster, or run the same image from a VM/container scheduler; no shared cluster
is required.

Run this package's local-fixture tests with `npm test --prefix apps/backup` from the repository root. No live credentials are needed.

```sh
node apps/backup/src/cli.mjs run --config backup.json
node apps/backup/src/cli.mjs prune --config backup.json --dry-run
node apps/backup/src/cli.mjs restore --config backup.json --into /scratch/new-drill --mark-verified
```

Secret inputs contain paths or descriptor numbers only:

- Encryption: `OCTOCOVE_BACKUP_ENC_KEY_FILE` or `OCTOCOVE_BACKUP_ENC_KEY_FD`.
- S3: `OCTOCOVE_BACKUP_S3_ACCESS_KEY_ID_FILE` and `OCTOCOVE_BACKUP_S3_SECRET_ACCESS_KEY_FILE` (or `_FD`). Prune credentials use the `OCTOCOVE_BACKUP_PRUNE_S3_` prefix.
- Repo entries: credential-free HTTPS `url`, plus `tokenFile` or `tokenFd` for Bearer authentication. Absolute local repo paths are supported.

Files/FDs must refer to private regular files owned by the job user (0600/0400); file inputs refuse symlinks. Legacy secret values in environment/config and credential-bearing URLs are refused. Git auth uses an unlinked descriptor. Children get an allowlisted environment and git uses isolated config. Hooks/exporters load their own scoped private inputs explicitly. Errors omit child stderr and S3 response bodies.

Prune requires a valid `verified.json` naming a complete generation and always keeps that recovery point. Only confirmed marker absence permits `--allow-unverified-prune` for explicit bootstrap (also needed for dry runs). Access errors, 403/503 and malformed markers stop deletion even with that flag. Prefer a passing restore with `--mark-verified` before scheduling prune.

Restore requires an absent or empty `--into` directory by default. Downloads, checksums, names/paths, refs and git integrity are verified in private staging before promotion. Failed validation leaves the destination untouched. `--overwrite` explicitly permits promotion over an existing directory after successful validation: the original is preserved intact at the returned `previousDestination`, for operator rollback/manual cleanup. Budget disk space for both copies. Failed drills return their report on stdout without publishing it into the destination or updating the verified marker.
