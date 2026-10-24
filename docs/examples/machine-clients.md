# Headless machine clients

These examples use the implemented machine approval routes. They do not qualify a live
issuer, provider, runtime isolation, or branch protection. Local conformance
uses signed fake issuers and native Git with explicit storage doubles; unsupported
cells remain BLOCKED.

Before running, a current human project administrator must provision through
the public API (all writes require an Idempotency-Key):

1. Register immutable principals with
   POST /v1/projects/{project}/approval-principals. Use separate canonical
   submitter and approver identities. Multiple subjects or rotated keys for one
   identity are aliases, not separation of duties.
2. Pin trust bindings: exact issuer, subject, algorithm, key ID and public JWK;
   optional JWKS URI must also be deployment-allow-listed. For GitHub Actions,
   register variant github_actions and exact repository_id, repository,
   workflow_ref, ref and environment claims. For Cron register workers_cron,
   worker_id and literal schedule claims with a pinned ES256 public key.
   Only the administrator can rotate trust.
3. Append approval-policies for each principal and a null-principal project
   target policy. Bind exact canonical/source repository IDs and target ref,
   checkIdentity and acceptableEvidence. Opt in with allowMachine:true and
   operations:["approve"] (approval is the only machine operation). Version
   starts at 1 and increments.
   No wildcard repositories or refs. Human-only targets remain closed.
4. The candidate comes from a lane's wrap-up by an authorized agent; machine
   registration does not create a claim or a candidate. Octocove computes the
   candidate and records actual check evidence. The approval scope is projectId, claimAttemptId, candidateId,
   boundTo:{candidateSha,baseSha,intentVersion}, and sorted latest required
   checkRunIds. Obtain these from the authenticated record, never from a
   job's assertion that checks passed.

The proof audience is the exact singleton string
<configured APPROVAL_API_ORIGIN>/auth/approval-grants.
iat, nbf and exp are required; lifetime must be at most five minutes.
GitHub's configured workflow/environment subject must match literally.
Cron scheduling itself confers no identity.

## CLI

Set OCTOCOVE_API_URL to the control plane /v1 URL and OCTOCOVE_ORG (or --org) to
the project's org; the grant file keeps that org for its use. Exchange needs no human
session and accepts OCTOCOVE_WORKLOAD_TOKEN or --token-stdin. Tokens never
belong in argv. --as is the registered canonical principal ID expected by the
caller; it cannot select the server's actor kind or identity.

    octocove auth exchange --as PRINCIPAL --scope "$APPROVAL_SCOPE" --token-stdin
    octocove auth approve --as PRINCIPAL --grant GRANT_ID
    octocove approve --grant GRANT_ID

An approval grant cannot save, wrap up, land or claim; the server refuses
canonical self-approval, including immutable delegated on-behalf-of provenance.

Exchange prints a JSON descriptor with id, orgId, principalId, expiresAt,
scope and policyVersion, never the workload proof or grant bearer. Bearers
are stored with mode 0600 below OCTOCOVE_CONFIG_DIR/grants in directories
with mode 0700; keep that directory private to the job and remove it at job
teardown. Machine commands always emit JSON; --timeout bounds API calls
(default 30 seconds, maximum 300). --idempotency-key recovers identical retries;
reuse does not extend authority. Error JSON contains the server's stable code
and status, exit 1 for refused API decisions, 78 for invalid local storage.
Ordinary human/delegation commands retain their existing exit codes.

    octocove --json auth revoke --grant GRANT_ID

Revocation requires a current human administrator session against the same API;
no bearer possession is needed; a bot cannot revoke or provision itself. Landing and receipt reads require
independent existing authorization. Use octocove land CANDIDATE --approval ID
and receipt show with that credential. Verify both the remote target Git object
and exported receipt object; a successful HTTP approval is not a landing.

See [GitHub workflow](github-machine-approve.yml) and
[Workers Cron](workers-machine-approve.mjs). The scopes are supplied by an
authenticated coordinator. Green provider checks trigger evaluation but cannot
replace Octocove's latest required check evidence.
