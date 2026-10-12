# 0025: In-app notifications are a per-recipient projection of the audit log
Status: accepted (storage, projection and the routes)

## Need and archetypes

People miss facts that need their attention: a candidate waiting for their approval, an approval of theirs that no
longer counts, work they asked for that landed or was blocked, a claim on their task that ended, a repository create
that needs the operator, or a project they were just added to. Every one of these is already a recorded fact (an
[audit log](../COLLABORATION_RECORD.md#10-audit-log) type), served on `GET /v1/events` and to webhooks. What
is missing is an answer to *which of these matter to me, and which have I seen*. Polling `/events` does not provide it:
the client would have to resolve recipients itself, with memberships and records it cannot see, and keep read state
nowhere.

- **Humans in the web app** need it: the bell, the notifications page and the notification settings.
- **The workspace adapter, own-clone CLI agents and CI + policy-bot approvers** do not. They already react to `/events`
  and webhooks, and v1 creates no machine recipients. The row shape does not assume a human recipient, so a future
  non-human subscriber (an orchestrator, say) would not need a second pipeline.

Two new nouns, **notification** and
**notification preferences**, fall under the
[glossary change rule](../GLOSSARY.md#change-rule-new-noun-state-or-write-route-needs-an-adr).

## Decision

**Notification** (`notifications`). A notification is one row per (recipient, event, kind): *this committed audit row
matters to this principal*, plus that principal's read time. It **adds no fact**. The event and the authoritative
record (task, candidate, approval, project) remain the source of truth; the row holds only ids (`project_id`,
`task_id`, `event_id`, the audit id behind the public `evt_<n>`), the kind, the event's own time as `created_at`, and
`read_at`. It copies no payload text, URL or secret; display text is derived when read. The recipient is an
`issuer`/`sub` pair, the same identity as a membership.

**Kinds (v1)** and their recipients, resolved as of the event (see **Recipients as of the event** below). Only human
members of the event's project can be recipients, and the actor of an event is never notified about their own action.

| Kind | Projected from (the one entity row) | Recipients |
| --- | --- | --- |
| `review-requested` | `candidate.computed` with `refs.entityType = candidate` and `toStatus = active` | members holding `candidates:approve`, except the claimant (the claim's human, or the human who delegated its agent) |
| `approval-invalidated` | `approval.invalidated` with `entityType = approval` | the approver |
| `landed` | `task.landed` with `entityType = task` (not the follow-up row) | the task creator and the approver of the approval the event names (`refs.approvalId`) |
| `candidate-blocked` | `candidate.blocked` (candidate entity) | the task creator |
| `claim-ended` | `claim.revoked`, `claim.released` with `entityType = claim` | the task creator |
| `repository-needs-operator` | `repository.creation_needs_operator` | the intent's requester and the project's `project:admin` members |
| `member-added` | `member.added` | the added principal |

Several of these types are written once per entity by one action: a computation writes `candidate.computed` for the
candidate and again for the task's move to `candidate`, and an invalidation writes `approval.invalidated` for the
approval and the task. Each kind therefore names the single entity row it projects, so one fact gives one notification per recipient.

**Projection.** The projector reads `audit_log` by a durable cursor (`notification_projector`), the way the webhook
dispatcher expands deliveries. Each
chunk of up to 100 raw audit positions, including positions that project nothing, commits its inserts and its cursor
advance in one D1 batch. A crash before the commit rolls back both. A crash after it resumes at the next chunk. A
rewound scan inserts nothing new, because of `UNIQUE(recipient_issuer, recipient_sub, event_id, kind)` and because
recipients are resolved as of the event. A concurrent scan inserts nothing at all: the batch is fenced as a whole. Its
first statement is the cursor compare-and-set, which moves the cursor from the position the tick read to the negated
chunk end, a marker no committed cursor holds. Every insert is gated on that marker, and the last statement settles
the cursor at the chunk end. A tick that lost the race (another tick moved the cursor after it read) matches nothing
in the first statement, so its inserts and its final update write nothing. The uniqueness key alone would not
suffice: it protects only pairs that already exist, so a losing tick could add a recipient who became eligible after
the winner committed.
A tick takes at most four chunks. The audit write path is unchanged. The cursor starts at the audit high-water mark
when the table is created, so enabling notifications notifies nobody about history.

**Recipients as of the event.** Recipients come from the records the event names and from memberships, filtered
to those that existed at the event. A membership counts unless a `member.added` row for that principal in that project
follows the event in audit order. Memberships are never updated in place: the member route inserts the membership and
its `member.added` row in one batch, and removal deletes it. A membership with no `member.added` row (a project
creator's, for example) predates every projected event. So a replay after a membership
change adds no one: a member added, or removed and re-added, after the event is not a recipient. A member removed
after the event and before projection is not projected either, and would not see the row anyway, because reads
re-check membership. Records are named by id from the event (`refs.approvalId` for `landed` and
`approval-invalidated`, `refs.candidateId`, `refs.intentId`), never "the latest" record of a task, so a later
approval on the same task cannot take over an earlier landing.

**Arming.** The projector runs on the existing `WebhookDispatcher` alarm (once a second), next to delivery and isolated
from its failures. The existing cron repairs a lost alarm, and when no dispatcher is bound, cron runs the projector
itself before delivery. There is no new public trigger, route or binding.

**Retention.** A row is kept for 90 days from its event, the replay horizon of
[ADR 0008](0008-replay-retention-and-cursor-rotation.md). Each tick deletes up to 500 expired rows, read or unread,
and an event already past 90 days is not projected. The sweep deletes only from `notifications`. `audit_log` stays
append-only, and the event is still readable on `/events`.

**Notification preferences** (`notification_preferences`). These are per recipient: `muted_kinds` and `muted_projects`
(JSON arrays), with everything on by default. They are applied when read, to the list and to the unread count, so a
change is immediate and rewrites no rows. Each preference change writes one `notification_preferences.updated` audit
row, ids only.

**Authorization.** A recipient sees only their own rows, for projects they are still a member of (re-checked per
request). A delegation or machine grant cannot read a human's notifications. Marking read is idempotent and not
audited.

**Routes.** Four human-only routes ([API.md](../API.md#your-notifications)). An agent delegation and a valid machine grant bearer get 403 `human-required`.

- `GET /v1/me/notifications?unread=&cursor=&limit=` answers `{items, nextCursor, unreadCount}`, newest first, with
  the shapes in [API.md](../API.md#your-notifications). One SQL predicate defines a *visible* row for every route: the caller's own, in
  a project they are still a member of, and not of a muted kind or project. The page and `unreadCount` are read
  under that predicate in one batch. `limit` is 0–100. `limit=0` answers `items: []` and `nextCursor: null` with the
  count, so the badge poll keeps the one response shape.
- `POST /v1/me/notifications/read` takes `{ids}` (1–100) or `{upTo}` and answers 204. It sets `read_at` only where
  it is unset, and only on visible rows. Anything else named is ignored, so the answer reveals nothing.
- `GET`/`PUT /v1/me/notification-preferences` read and replace `{mutedKinds, mutedProjects}`. The `PUT` validates
  kinds against the closed set and projects against the caller's memberships, both as 400 `invalid-request`. The
  project refusal gives the same answer for a project that exists and one that does not. Each `PUT` writes one
  audit row, with no project, so no project's `/audit` or `/events` serves it.

Further choices:

- **Ids.** A notification's `id` is `ntf_<n>`, the row id, which orders the feed. `eventId` is the `evt_<n>` that
  `/events` and webhooks use.
- **Cursor.** It is the signed keyset cursor of `GET /tasks`, bound to the caller and the `unread`
  filter, not a bare id. A bare id would be safe here, because every query is bound to the caller in SQL. The signed
  cursor keeps one cursor convention across the API's paged human reads.
- **Marks are visible-only.** A mark does not reach a muted or hidden row, so unmuting a kind or rejoining a project
  shows its rows as they were. "Mark all read" (`upTo` the newest listed id) means "everything I could see".
- **Replay.** A mark keeps no ledger row. It only ever sets an unset `read_at`, so any repeat, with the same key or
  another, changes nothing more, and frequent personal state does not grow the append-only operation ledger. The
  `PUT` is ledgered like the other human writes: a same-key replay answers the committed body, and another body is
  409.
- **Display fields.** `taskTitle` is the task's current intent title and appears only when the membership holds
  `tasks:read`. Recipients are fixed once, as of the event, and a narrowed membership should not still read titles.
- **Preferences read.** `mutedProjects` lists only projects the caller is still a member of, so a `GET` can always
  be sent back as a `PUT`.

**Per-organization records.** Notifications, preferences and the projector cursor live beside the `audit_log` they
are projected from. If records are held per organization, each organization's record holds its own, and the projector
runs per record database, as the webhook dispatcher does. Nothing here is a cross-tenant singleton.

## Does not do

- It schedules, claims, launches and retries nothing, and changes no record state. Reading or dismissing a
  notification changes only `read_at` ([glossary scope fence](../GLOSSARY.md#scope-fence)).
- No email, push or other channel, and no digests or grouping.
- No machine or agent recipients in v1. Recipients are human members only.
- One new audit type only, `notification_preferences.updated`. Read marks are never audited, because they are
  personal state, not a record fact.
- No "access expiring" kind. There is no delegation event vocabulary for it yet.

## Consequences and alternatives

- **Keyed with `kind` vs on `(recipient, eventId)` alone.** Each type maps to at most one kind, so the two keys are
  equivalent today. The wider key leaves room for a later kind projected from a type that is already used, without a
  schema change.
- **Projected at write time vs computed on read.** Computing recipients on every read would mean scanning the event
  stream per person and would leave nowhere to keep read state. Projecting fixes recipients once, as of the event.
- **Fencing in the batch vs a single-writer lease.** A Durable Object or lease would also serialize ticks, but the
  projector already shares the dispatcher's alarm and cron fallback, which can overlap. Fencing in the one D1 batch
  makes overlap harmless without another binding. Membership is still re-checked on read, so a member who leaves stops seeing the project's
  notifications.
- **Its own alarm vs the dispatcher's.** A second durable object would add a binding and its own configuration for the same
  once-a-second cadence. Sharing the dispatcher's alarm keeps one wake path, and a projector failure is logged
  (`notification-projection-failed`) without stopping delivery.
Affected: [API](../API.md#your-notifications), `spec/openapi.yaml`, [COLLABORATION_RECORD §10](../COLLABORATION_RECORD.md#10-audit-log)
and the glossary entry [Notification](../GLOSSARY.md#notification-notifications-notification_preferences).
