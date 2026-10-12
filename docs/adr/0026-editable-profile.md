# 0026: A signed-in human edits their own profile
Status: proposed

## Need and archetypes

A person's name in Octocove is whatever their identity provider sends at sign-in (`auth_users.display_name`), and
they cannot change it. The web app's Account tab wants people to set the name their collaborators see, plus their
pronouns, a short bio and their time zone. The provider's values cannot hold an edit: every sign-in and
re-authentication upserts `auth_users` and overwrites `email` and `display_name` with the new ID token's claims.

Only **humans** need this, through the web app (and later the CLI, with the same session). The **workspace adapter**,
**own-clone CLI agents** and **CI + policy-bot approvers** act through delegations and machine grants. They have no
profile and are refused by the write route.

## Decision

**New state: the profile.** `user_profiles(issuer, sub, name, pronouns, bio, timezone, updated_at)`,
one row per provider identity, created by the first edit. Every field is nullable; NULL means not set. It is a
separate table rather than new `auth_users` columns, so the sign-in upsert stays exactly as it is and cannot erase
an edit. The profile describes the person only: it grants nothing, and the principal id (`issuer|sub`) never
changes.

**New write route: `PATCH /v1/me/profile`** (`meProfileUpdate`, also unprefixed). The body names any of `name`,
`pronouns`, `bio` and `timezone`. A key that is present sets the field, `null` clears it, and an absent key leaves it
unchanged. Any other key is 400 `invalid-request`. The answer is 200 `{profile}`.

- **Validation.** Strings are trimmed, then checked, and lengths count Unicode code points:
  - `name`: 1–80. An empty name is invalid; clear it with `null`.
  - `pronouns`: at most 40.
  - `bio`: at most 280.
  - `pronouns` and `bio` are cleared when they are empty after trimming.
  - No field may contain a control character (`\p{Cc}`: C0 including tab and newline, DEL, C1).
  - `timezone`: an IANA zone name (`Area/Location`, `UTC`) that `Intl.DateTimeFormat` accepts. Offsets such as `+01:00` are refused even though the runtime accepts them. The zone is stored as `Intl` resolves it.
  - The first invalid field, in that order, is 400 `invalid-profile` with `details.field`, and nothing is written.
- **Authority.** The route is for human sessions only. The gateway rule is `access: "human"`, so a delegation gets 403 `human-required`. The rule also sets `machineGrant`, so a machine grant bearer reaches the handler, which refuses it 403 `human-required`, as on `GET /me/delegations`. Cookie callers pass the session's Origin and CSRF check, which applies to every unsafe method. PATCH joins POST in `missingIdempotencyKey`, so the route needs an `Idempotency-Key`. The CORS preflight allows PATCH. A recent sign-in is not required: an edit hands out no authority.
- **One batch.** One D1 batch does all of the following:
  - It opens with an `auth_cas` guard that re-proves the calling session and family are live. A lost session gives 401 `credential-revoked`.
  - It upserts the named columns only, so concurrent edits of different fields both stand.
  - It appends the `profile.updated` audit row.
  - It writes the answer to the per-principal admin-operation ledger (`machine_admin_operations`), like member and repository writes. The same key and body replay the committed answer; the same key with another body is 409 `idempotency-conflict`.
- **Empty body.** A body naming no field writes nothing, audits nothing and answers the current profile.

**Audit: `profile.updated`.** This type is added to the closed vocabulary. The row's actor is the human, and its refs are `{principalId, fields}`: the names
of the fields the request set, never their values, so the append-only log never holds personal text. A profile
belongs to no project, so `project_id` and `task_id` are NULL. This follows the other `me` write audited in
`audit_log`, `notification_preferences.updated` ([ADR 0025](0025-in-app-notifications.md)); sign-in revocations keep
their evidence in `auth_family_revocations` instead. Every `/audit` and `/events` read is scoped to a project, and webhooks deliver by project, so `profile.updated` is in
**neither** stream and no notification is projected from it. That is intended. A collaborator learns a new name by
reading it, not from an event. The row is evidence for operators.

**Reads.**

- `GET /me` adds `profile: {name, pronouns, bio, timezone}` for a human. `name` falls back to the provider's display name, so it is null only when neither exists. `principal.displayName` and `principal.email` stay the provider's values.
- `GET /projects/{project}/members` items keep `displayName` (the provider's value) and add `name`: the profile name, falling back to `displayName`, and omitted when neither exists, like `displayName`. Clients show `name`.
- Both additions are additive, so existing clients are unaffected.

## Does not do

- **No email change.** Email belongs to the identity provider and stays on `principal.email`.
- **No avatar** or other media, and no profile URL.
- **No profile page or lookup.** Nothing new is visible across organizations or projects. Another person sees only the `name` in the member lists they could already read. Pronouns, bio and time zone are returned only to their owner (`GET /me`).
- **No edit of anyone else's profile**, and no admin override.
- **No history read.** The audit row records that fields changed, not what they were.
- **No uniqueness.** Two people may share a name; principals stay identified by `principalId`.
- **Changes nothing about authority:** no verb, membership or session is created or changed.

## Consequences and alternatives

- **New columns on `auth_users`, kept out of the sign-in upsert.** Rejected: every sign-in path would have to keep excluding them, and a future upsert that forgot one would silently erase edits. A separate table makes "sign-in never writes it" structural.
- **Reusing `display_name` and stopping sign-in from refreshing it.** Rejected: people whose provider name changes would stop seeing the update, and the provider's value would no longer be readable.
- **Placement under a per-organization split.** If records are later split per organization, the profile belongs with the sign-in identity, not with any organization's record. Its `profile.updated` rows would move with it, as identity evidence beside the sign-in revocations.

Affected: [API](../API.md#your-profile-patch-meprofile), `spec/openapi.yaml` (`meProfileUpdate`, `Profile`,
`Member.name`), [COLLABORATION_RECORD §10](../COLLABORATION_RECORD.md#10-audit-log), and the client's
`auth.profile.update()` (`replay: stored-result`).
