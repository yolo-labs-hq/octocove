# Off-Cloudflare nightly mirrors and restore drill

Artifacts (or a BYO git provider) must not be the only copy of canonical history: this job keeps independent, encrypted nightly snapshots of every repository and of the D1 record outside Cloudflare, and proves them with restore drills. Code: [`apps/backup`](../apps/backup) — dependency-free Node ≥20 ESM, needs `git` and `tar`. One CLI, one container image ([Dockerfile](../apps/backup/Dockerfile)), Kubernetes CronJobs in [deploy/cronjob.yaml](../apps/backup/deploy/cronjob.yaml).

## Limitations

| Part | Limitation |
| --- | --- |
| Test coverage | Mirror, snapshot, encryption, manifest, retention, freshness check and restore + drill report are tested against local bare repos, a local directory store and a local S3-compatible HTTP server (`pnpm --filter @octocove/backup test`), not against real storage, Artifacts or D1. |
| Landing fence for the recovery cut | The control plane has no endpoint to fence landing/destructive deletion. The job exposes `cut.beginCommand` / `cut.endCommand` hooks; without a fence, runs are *not* a transactionally consistent cut and must not be described as one. |
| Repo list and "referenced SHA" query | Supplied by operator scripts (`reposCommand`, `referencedShasCommand`); the control plane has no admin listing API. |
| S3 multipart upload | Not implemented: each object is a single PUT (limit 5 GB per bundle/object on S3; B2 same). Larger repos cannot be backed up. |

## What a run does

1. `cut.beginCommand` (optional) → export metadata (`metadata.command`, stdout = SQL dump) → `referencedShasCommand` (optional; JSON lines `{"repo","sha"}` for every receipt/submission/candidate SHA) → `git init --bare` / `git fetch --prune` with all-ref refspec per repo → `cut.endCommand` (always runs).
2. Fail the run if any referenced SHA is missing from a mirror.
3. For each repo, `git bundle create --all` (all refs, including `refs/candidates/*`), `git bundle verify`, encrypt, upload. Evidence directory is tarred and uploaded; metadata is uploaded.
4. Upload the **manifest last** (`generations/<UTC id>/manifest.json[.enc]`): ref→SHA map and HEAD per repo, SHA-256 of every stored and plaintext object, schema version, counts. A generation without a manifest is incomplete and is never used for restore, retention or freshness. A failed run leaves earlier generations untouched; the retry is a new generation.

Each generation is an independent full snapshot, so upstream ref deletions cannot overwrite history. Mirrors in `workDir` are only a fetch cache. Repo URLs must be credential-free HTTPS URLs (absolute local paths are supported for disk custody/tests); URL userinfo, query strings and `${ENV}` expansion are refused. Repo entries use `tokenFile` or `tokenFd` for scoped Bearer credentials. Git receives the header through a private, unlinked descriptor; argv and persistent mirror config never contain it, including after failed fetches. Children inherit only PATH, a fixed HOME and locale/timezone variables; git also receives fixed isolated configuration settings (global/system config, helpers and hooks disabled). Hooks/exporters must load their own scoped credentials from explicit private file paths, rather than inherited secrets. Raw child stderr and S3 response bodies are never included in errors.

**Encryption:** AES-256-GCM per object (random IV, tag verified on restore; a wrong key or modified byte fails). Key: `OCTOCOVE_BACKUP_ENC_KEY_FILE` (private file path) or `OCTOCOVE_BACKUP_ENC_KEY_FD` (open descriptor ≥3), containing 32 random bytes base64 (`openssl rand -base64 32`), kept outside Cloudflare and separately escrowed — losing it loses every backup. The manifest is encrypted too and the GCM tag plus the per-object checksums inside it are its integrity protection (there is no separate signing key). `"encryption": "none"` exists for bootstrap/disk use and is not acceptable for custody of customer data.

## Configuration

See [backup.example.json](../apps/backup/backup.example.json). `destination`:

- `{"type":"s3","endpoint","bucket","region","prefix"}` — any S3-compatible store (B2, S3, GCS interop, MinIO). Credentials from `OCTOCOVE_BACKUP_S3_ACCESS_KEY_ID_FILE` / `OCTOCOVE_BACKUP_S3_SECRET_ACCESS_KEY_FILE` (write/list/read only), or the corresponding `_FD` descriptor numbers.
- `{"type":"fs","path":"/mnt/backups"}` — the disk bootstrap case; the path must be on an independently operated host with versioned snapshots. A container's ephemeral disk does not qualify.

Use a store operated independently of Cloudflare and of the systems being backed up (for example a separate B2/S3/GCS account); an existing backup store qualifies only if that independence is confirmed. Use delete-separated credentials: if `OCTOCOVE_BACKUP_PRUNE_S3_ACCESS_KEY_ID_FILE`/`OCTOCOVE_BACKUP_PRUNE_S3_SECRET_ACCESS_KEY_FILE` (or `_FD`) are set, `prune` uses them, so the nightly job's token cannot erase history (also enable bucket object-lock/versioning).

All secret inputs must be regular files owned by the job user, with no group/other permissions (0600 or 0400); final-path symlinks are refused. FDs may refer to unlinked private regular files and are read without advancing their position. Set environment variables to **paths or descriptor numbers only**: legacy secret values in environment/config are refused. Mount/copy Kubernetes secret files privately for the container user; do not use `envFrom`. Do not put secrets in command arguments.

Example repo entry: `{"name":"canonical","url":"https://git.example.org/org/repo","tokenFile":"/secrets/source-token"}`. Operator scripts supplied by `reposCommand` return the same shape.

## Commands

```
node src/cli.mjs run     --config backup.json
node src/cli.mjs prune   --config backup.json [--dry-run] [--allow-unverified-prune]
node src/cli.mjs check   --config backup.json          # exit 1 if newest complete generation is >26h old
node src/cli.mjs restore --config backup.json --into /scratch/drill [--generation ID|latest] [--repo NAME | --random-repo] [--mark-verified] [--overwrite]
```

**Retention:** newest generation per UTC day (30), per ISO week (8) and per month (12), plus the generation recorded in `verified.json` by the last passing drill (`--mark-verified`), plus the newest complete one. Incomplete generations older than 48 h (and older than the newest complete) are removed. This deletes backup history only, never live audit rows. Prune fails closed on marker access errors (including 403/503), malformed markers or markers naming a missing/incomplete generation. With confirmed absence only (S3 404 / local missing file), bootstrap requires the explicit `--allow-unverified-prune` flag, including for dry runs. The flag cannot bypass an invalid/unreadable marker. Prefer a passing `restore --mark-verified` before enabling prune; never leave the bootstrap flag on the scheduled job.

**Alerting:** run `check` hourly (CronJob provided); a failing Job is the 26-hour alert. Wire Job failure to the operator's paging.

## Restore drill

Uses only the destination credentials and the encryption key — no Cloudflare access. `--into` must be absent or an empty directory by default; existing repositories are refused before any download. Names, object paths and destination containment are validated, and symlink destinations/ancestors and unsafe evidence archives are refused. All downloads, checksums and git checks run in a private sibling staging directory. Only a passing restore is promoted; failures leave the destination untouched and discard staging. `--overwrite` explicitly permits promotion over an existing directory **after validation**: the old directory is moved intact to a private sibling backup, whose path is returned as `previousDestination`; keep it for rollback and remove it manually when satisfied. This needs disk space for both copies. Failed drills return a report on stdout without writing to the destination or updating `verified.json`.

1. Monthly (and before accepting customer custody): pick a repo (`--random-repo`, rotating to the largest each drill) in an isolated environment:
   `node src/cli.mjs restore --config backup.json --into /scratch/drill --random-repo --mark-verified`
2. The command downloads the manifest, verifies stored and plaintext checksums, rebuilds bare repos at `repos/<name>.git`, runs `git fsck --full`, compares every ref/SHA to the manifest (missing, wrong or unexpected refs fail), checks objects exist, restores `metadata.sql` and `evidence/`, and writes `drill-report.json` (generation, elapsed ms, bytes, missing objects, per-repo problems). Exit code 1 on any problem.
3. Load `metadata.sql` into a fresh SQLite/D1 (`wrangler d1 execute --local --file`, or `sqlite3`), run `node tools/check-record-invariants.mjs` against it where applicable, and compare audit-log row counts/digests with the manifest's generation date. Demonstrate `git clone repos/<name>.git`, a diff, and a receipt lookup by SHA. (These last steps are manual; the script automates 2.)
4. Quarterly: omit `--repo`/`--random-repo` to restore the whole fleet into a fresh Forgejo/plain git server and fresh metadata DB. Compare `elapsedMs`/`bytes` against the RTO ≤ 4 h target for 100 GB and keep the drill report.
5. A passing run with `--mark-verified` writes `verified.json`; retention then keeps that generation until a newer drill passes.

## Operator checklist to go live

1. Provision destination bucket in a non-Cloudflare account; create write and separate prune credentials; enable versioning/object-lock.
2. Generate and escrow the encryption key; mount it privately and set `OCTOCOVE_BACKUP_ENC_KEY_FILE`.
3. Write `list-repos`, `referenced-shas` and fence scripts (or accept the documented consistency gap); provide Artifacts read tokens and D1 export access (`wrangler d1 export`) as secrets.
4. Build and push the image, apply the CronJobs, run once manually, then run the first restore drill and record it.
