-- 0001_record.sql — Octocove collaboration record (Cloudflare D1 / SQLite).
--
-- Specification: docs/COLLABORATION_RECORD.md. Every table, column, view and trigger
-- in this file is defined there; invariants are numbered INV-nn in that document and
-- listed with their test names in tests/record-invariants.todo.md.
--
-- Conventions
--   * ids are opaque TEXT (ULID recommended, sortable by creation); audit_log.id is the
--     only integer id (AUTOINCREMENT: monotonic, never reused).
--   * timestamps are ISO-8601 UTC TEXT with millisecond precision ("2026-10-04T12:34:56.789Z").
--   * JSON is TEXT validated with json_valid(); shape is documented per column.
--   * actors are (actor_type, actor_id) pairs; actor_type in human|agent|integrator|system.
--   * Immutable records: triggers RAISE(ABORT) on UPDATE/DELETE. Records that carry an ACTIVE
--     status (claims, candidates, approvals, fences) allow UPDATE of the status columns only,
--     and only along the transitions enumerated in the *_status_transitions tables.
--   * D1 enforces foreign keys by default; this file relies on it.

-- Remove an obsolete table if present.
DROP TABLE IF EXISTS schema_marker;

-- ---------------------------------------------------------------------------
-- 1. Identity: project, canonical repository, target ref
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE repositories (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  provider            TEXT NOT NULL DEFAULT 'artifacts' CHECK (provider IN ('artifacts')),
  provider_namespace  TEXT NOT NULL,
  provider_repo_id    TEXT NOT NULL,
  name                TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('canonical', 'task', 'staging')),
  created_at          TEXT NOT NULL,
  deleted_at          TEXT,
  UNIQUE (provider, provider_namespace, provider_repo_id)
);

-- A ref the control plane lands onto. known_head_* is the last canonical head the control
-- plane has evidence for (a receipt, an ls-remote, or an event); it is a cache of observed
-- truth, never authority — the integrator's compare-and-swap push is the authority.
CREATE TABLE target_refs (
  repository_id      TEXT NOT NULL REFERENCES repositories(id),
  ref_name           TEXT NOT NULL,
  known_head_sha     TEXT,
  known_head_at      TEXT,
  known_head_source  TEXT CHECK (known_head_source IN ('seed', 'receipt', 'ls-remote', 'event')),
  PRIMARY KEY (repository_id, ref_name)
);

-- ---------------------------------------------------------------------------
-- 2. Task + intent history + dependencies
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  repository_id           TEXT NOT NULL,
  target_ref              TEXT NOT NULL,
  key                     TEXT NOT NULL,
  -- task status: the lifecycle of the task's accepted result (never of an attempt)
  status                  TEXT NOT NULL CHECK (status IN (
                            'draft', 'ready', 'claimed', 'submitted', 'candidate',
                            'approved', 'landing', 'landed', 'rejected', 'superseded')),
  status_changed_at       TEXT NOT NULL,
  current_intent_version  INTEGER NOT NULL DEFAULT 1 CHECK (current_intent_version >= 1),
  published_at            TEXT,
  -- write-once: the landing receipt that made this task 'landed' (the accepted result)
  accepted_receipt_id     TEXT,
  superseded_by_task_id   TEXT REFERENCES tasks(id),
  closed_at               TEXT,
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (project_id, key),
  FOREIGN KEY (repository_id, target_ref) REFERENCES target_refs(repository_id, ref_name),
  CHECK ((status IN ('landed', 'rejected', 'superseded')) = (closed_at IS NOT NULL)),
  CHECK ((status = 'superseded') = (superseded_by_task_id IS NOT NULL)),
  CHECK ((status = 'landed') = (accepted_receipt_id IS NOT NULL))
);

CREATE INDEX tasks_by_project_status ON tasks(project_id, status);

CREATE TABLE task_status_transitions (
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO task_status_transitions (from_status, to_status, trigger) VALUES
  ('draft',     'ready',      'publish + admission rule satisfied'),
  ('draft',     'rejected',   'human closes the task'),
  ('draft',     'superseded', 'human supersedes the task'),
  ('ready',     'draft',      'dependency added or intent unpublished'),
  ('ready',     'claimed',    'claim granted'),
  ('ready',     'rejected',   'human closes the task'),
  ('ready',     'superseded', 'human supersedes the task'),
  ('claimed',   'ready',      'active claim released/revoked/expired with no submission'),
  ('claimed',   'submitted',  'first submission recorded'),
  ('claimed',   'rejected',   'human closes the task'),
  ('claimed',   'superseded', 'human supersedes the task'),
  ('submitted', 'candidate',  'integrator computed a candidate for the latest submission'),
  ('submitted', 'rejected',   'human closes the task'),
  ('submitted', 'superseded', 'human supersedes the task'),
  ('candidate', 'submitted',  'candidate superseded (new submission) or stale (base move)'),
  ('candidate', 'approved',   'approval recorded'),
  ('candidate', 'rejected',   'human closes the task'),
  ('candidate', 'superseded', 'human supersedes the task'),
  ('approved',  'candidate',  'approval invalidated by intent edit or withdrawal'),
  ('approved',  'submitted',  'approval invalidated by new submission or base move'),
  ('approved',  'landing',    'fence acquired'),
  ('approved',  'rejected',   'human closes the task'),
  ('approved',  'superseded', 'human supersedes the task'),
  ('landing',   'landed',     'fence released with resolution landed'),
  ('landing',   'submitted',  'fence released with resolution raced/conflict, or error with base moved'),
  ('landing',   'approved',   'fence released with resolution error and tuple still valid');

CREATE TRIGGER tasks_immutable_identity
BEFORE UPDATE OF id, project_id, repository_id, target_ref, key, created_by, created_at ON tasks
BEGIN
  SELECT RAISE(ABORT, 'tasks: identity columns are immutable');
END;

CREATE TRIGGER tasks_status_transition
BEFORE UPDATE OF status ON tasks
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM task_status_transitions
  WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN
  SELECT RAISE(ABORT, 'tasks: status transition not allowed');
END;

CREATE TRIGGER tasks_accepted_receipt_write_once
BEFORE UPDATE OF accepted_receipt_id ON tasks
FOR EACH ROW WHEN OLD.accepted_receipt_id IS NOT NULL AND NEW.accepted_receipt_id IS NOT OLD.accepted_receipt_id
BEGIN
  SELECT RAISE(ABORT, 'tasks: accepted_receipt_id is write-once');
END;

CREATE TRIGGER tasks_intent_version_monotonic
BEFORE UPDATE OF current_intent_version ON tasks
FOR EACH ROW WHEN NEW.current_intent_version < OLD.current_intent_version
BEGIN
  SELECT RAISE(ABORT, 'tasks: current_intent_version never decreases');
END;

CREATE TRIGGER tasks_no_delete
BEFORE DELETE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'tasks are never deleted; close them (rejected/superseded)');
END;

-- Every edit is a new row; the table IS the edit history. tasks.current_intent_version
-- always equals MAX(version) for the task (INV-02, application-maintained, tested).
CREATE TABLE intents (
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  title                   TEXT NOT NULL CHECK (length(title) > 0),
  description             TEXT NOT NULL DEFAULT '',
  acceptance_criteria     TEXT NOT NULL CHECK (json_valid(acceptance_criteria) AND json_type(acceptance_criteria) = 'array'),
  change_note             TEXT,
  author_type             TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  author_id               TEXT NOT NULL,
  -- set when a held fence existed on the task at edit time: the edit is recorded now, its
  -- lifecycle effect (approval invalidation) is deferred until the fence is released
  staged_behind_fence_id  TEXT REFERENCES landing_fences(id),
  created_at              TEXT NOT NULL,
  PRIMARY KEY (task_id, version)
);

CREATE TRIGGER intents_no_update BEFORE UPDATE ON intents
BEGIN SELECT RAISE(ABORT, 'intents are immutable; add a new version'); END;
CREATE TRIGGER intents_no_delete BEFORE DELETE ON intents
BEGIN SELECT RAISE(ABORT, 'intents are never deleted'); END;

CREATE TABLE task_dependencies (
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TRIGGER task_dependencies_no_update BEFORE UPDATE ON task_dependencies
BEGIN SELECT RAISE(ABORT, 'task_dependencies rows are immutable'); END;

-- Dependencies may be removed only while the dependent is still unclaimed.
CREATE TRIGGER task_dependencies_delete_only_unclaimed
BEFORE DELETE ON task_dependencies
FOR EACH ROW WHEN (SELECT status FROM tasks WHERE id = OLD.task_id) NOT IN ('draft', 'ready')
BEGIN
  SELECT RAISE(ABORT, 'task_dependencies: removable only while the task is draft or ready');
END;

-- ---------------------------------------------------------------------------
-- 3. Claim attempts (who, when, delegation, result) + accepted dependency results
-- ---------------------------------------------------------------------------

CREATE TABLE claims (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  actor_type         TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id           TEXT NOT NULL,
  authorized_by      TEXT,
  delegation_id      TEXT,
  intent_version     INTEGER NOT NULL,
  requested_at       TEXT NOT NULL,
  result             TEXT NOT NULL CHECK (result IN (
                       'granted', 'refused-not-ready', 'refused-already-claimed',
                       'refused-dependency-unlanded', 'refused-unauthorized', 'refused-task-closed')),
  refusal_detail     TEXT,
  idempotency_key    TEXT UNIQUE,
  expires_at         TEXT,
  -- attempt status (mutable); present iff result = 'granted'
  status             TEXT CHECK (status IN ('active', 'released', 'revoked', 'superseded', 'completed')),
  status_changed_at  TEXT,
  status_reason      TEXT,
  FOREIGN KEY (task_id, intent_version) REFERENCES intents(task_id, version),
  CHECK ((result = 'granted') = (status IS NOT NULL)),
  CHECK ((result = 'granted') = (status_changed_at IS NOT NULL)),
  CHECK (actor_type = 'human' OR authorized_by IS NOT NULL),
  CHECK (actor_type = 'human' OR result <> 'granted' OR delegation_id IS NOT NULL)
);

CREATE INDEX claims_by_task ON claims(task_id, requested_at);
CREATE UNIQUE INDEX claims_one_active_per_task ON claims(task_id) WHERE result = 'granted' AND status = 'active';

CREATE TABLE claim_status_transitions (
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, PRIMARY KEY (from_status, to_status)
);
INSERT INTO claim_status_transitions VALUES
  ('active', 'released'), ('active', 'revoked'), ('active', 'superseded'), ('active', 'completed');

CREATE TRIGGER claims_immutable_fields
BEFORE UPDATE OF id, task_id, actor_type, actor_id, authorized_by, delegation_id, intent_version,
                 requested_at, result, refusal_detail, idempotency_key, expires_at ON claims
BEGIN SELECT RAISE(ABORT, 'claims: only status columns may change'); END;

CREATE TRIGGER claims_status_transition
BEFORE UPDATE OF status ON claims
FOR EACH ROW WHEN NEW.status IS NOT OLD.status AND NOT EXISTS (
  SELECT 1 FROM claim_status_transitions WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'claims: status transition not allowed'); END;

CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
BEGIN SELECT RAISE(ABORT, 'claims are never deleted'); END;

-- The exact accepted upstream results the admission check saw when this claim was granted.
CREATE TABLE claim_dependency_results (
  claim_id          TEXT NOT NULL REFERENCES claims(id),
  upstream_task_id  TEXT NOT NULL REFERENCES tasks(id),
  receipt_id        TEXT NOT NULL REFERENCES landing_receipts(id),
  landed_sha        TEXT NOT NULL,
  PRIMARY KEY (claim_id, upstream_task_id)
);

CREATE TRIGGER claim_dependency_results_no_update BEFORE UPDATE ON claim_dependency_results
BEGIN SELECT RAISE(ABORT, 'claim_dependency_results are immutable'); END;
CREATE TRIGGER claim_dependency_results_no_delete BEFORE DELETE ON claim_dependency_results
BEGIN SELECT RAISE(ABORT, 'claim_dependency_results are never deleted'); END;

-- Durable mapping from the place an agent pushes (task repo, or lane ref in canonical) to the
-- task. Events are routed through this table, never through an active token grant.
CREATE TABLE task_repo_mappings (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  claim_id       TEXT REFERENCES claims(id),
  kind           TEXT NOT NULL CHECK (kind IN ('task-repo', 'lane-ref')),
  repository_id  TEXT NOT NULL REFERENCES repositories(id),
  ref_name       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  retired_at     TEXT
);

CREATE UNIQUE INDEX task_repo_mappings_live ON task_repo_mappings(repository_id, ref_name) WHERE retired_at IS NULL;
CREATE INDEX task_repo_mappings_by_task ON task_repo_mappings(task_id);

CREATE TRIGGER task_repo_mappings_immutable_fields
BEFORE UPDATE OF id, task_id, claim_id, kind, repository_id, ref_name, created_at ON task_repo_mappings
BEGIN SELECT RAISE(ABORT, 'task_repo_mappings: only retired_at may change'); END;
CREATE TRIGGER task_repo_mappings_retire_once
BEFORE UPDATE OF retired_at ON task_repo_mappings
FOR EACH ROW WHEN OLD.retired_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'task_repo_mappings: retired_at is write-once'); END;
CREATE TRIGGER task_repo_mappings_no_delete BEFORE DELETE ON task_repo_mappings
BEGIN SELECT RAISE(ABORT, 'task_repo_mappings are never deleted'); END;

-- ---------------------------------------------------------------------------
-- 4. Push observations (events) and submissions (+ context snapshot)
-- ---------------------------------------------------------------------------

-- What the provider told us happened. Never attributed to anyone by itself; an authenticated
-- submission is what binds an actor. event_id is the transport identity used for dedupe.
CREATE TABLE push_observations (
  id                     TEXT PRIMARY KEY,
  event_id               TEXT NOT NULL UNIQUE,
  event_kind             TEXT NOT NULL CHECK (event_kind IN ('pushed', 'forked', 'deleted', 'ls-remote')),
  provider_repo_id       TEXT NOT NULL,
  repository_id          TEXT REFERENCES repositories(id),
  ref_name               TEXT,
  before_sha             TEXT,
  after_sha              TEXT,
  event_at               TEXT,
  received_at            TEXT NOT NULL,
  task_id                TEXT REFERENCES tasks(id),
  mapping_id             TEXT REFERENCES task_repo_mappings(id),
  payload                TEXT CHECK (payload IS NULL OR json_valid(payload)),
  -- classification (mutable: set once the observation is matched or flagged)
  flag                   TEXT CHECK (flag IN ('matched', 'unsubmitted-push', 'unknown-repo', 'reconcile', 'canonical')),
  matched_submission_id  TEXT REFERENCES submissions(id),
  flagged_at             TEXT
);

CREATE INDEX push_observations_by_task ON push_observations(task_id, received_at);

CREATE TRIGGER push_observations_immutable_fields
BEFORE UPDATE OF id, event_id, event_kind, provider_repo_id, repository_id, ref_name, before_sha,
                 after_sha, event_at, received_at, task_id, mapping_id, payload ON push_observations
BEGIN SELECT RAISE(ABORT, 'push_observations: only classification columns may change'); END;
CREATE TRIGGER push_observations_no_delete BEFORE DELETE ON push_observations
BEGIN SELECT RAISE(ABORT, 'push_observations are never deleted'); END;

-- Immutable. A new push = a new submission with the next seq; nothing is ever updated.
CREATE TABLE submissions (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  claim_id                TEXT NOT NULL REFERENCES claims(id),
  seq                     INTEGER NOT NULL CHECK (seq >= 1),
  actor_type              TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id                TEXT NOT NULL,
  source_sha              TEXT NOT NULL,
  base_sha                TEXT NOT NULL,
  intent_version          INTEGER NOT NULL,
  mapping_id              TEXT NOT NULL REFERENCES task_repo_mappings(id),
  message                 TEXT,
  staged_behind_fence_id  TEXT REFERENCES landing_fences(id),
  idempotency_key         TEXT UNIQUE,
  created_at              TEXT NOT NULL,
  UNIQUE (task_id, seq),
  FOREIGN KEY (task_id, intent_version) REFERENCES intents(task_id, version)
);

CREATE INDEX submissions_by_claim ON submissions(claim_id, seq);

CREATE TRIGGER submissions_no_update BEFORE UPDATE ON submissions
BEGIN SELECT RAISE(ABORT, 'submissions are immutable; a new push is a new submission'); END;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON submissions
BEGIN SELECT RAISE(ABORT, 'submissions are never deleted'); END;

-- Frozen copy of what the submitter was working against. Written in the same batch as the
-- submission; duplicates a few submission columns on purpose (the copy is the point).
CREATE TABLE submission_contexts (
  submission_id        TEXT PRIMARY KEY REFERENCES submissions(id),
  intent_version       INTEGER NOT NULL,
  intent_title         TEXT NOT NULL,
  acceptance_criteria  TEXT NOT NULL CHECK (json_valid(acceptance_criteria) AND json_type(acceptance_criteria) = 'array'),
  base_sha             TEXT NOT NULL,
  canonical_head_sha   TEXT,
  actor_type           TEXT NOT NULL,
  actor_id             TEXT NOT NULL,
  claim_id             TEXT NOT NULL REFERENCES claims(id),
  -- [{ "upstreamTaskId": "...", "receiptId": "...", "landedSha": "..." }]
  dependency_results   TEXT NOT NULL CHECK (json_valid(dependency_results) AND json_type(dependency_results) = 'array'),
  snapshot_at          TEXT NOT NULL
);

CREATE TRIGGER submission_contexts_no_update BEFORE UPDATE ON submission_contexts
BEGIN SELECT RAISE(ABORT, 'submission_contexts are immutable'); END;
CREATE TRIGGER submission_contexts_no_delete BEFORE DELETE ON submission_contexts
BEGIN SELECT RAISE(ABORT, 'submission_contexts are never deleted'); END;

-- ---------------------------------------------------------------------------
-- 5. Candidates (+ check runs)
-- ---------------------------------------------------------------------------

-- One row per integrator compute run. outcome = 'computed' is a candidate proper; the other
-- outcomes keep the evidence of a blocked compute (e.g. the conflict file list).
CREATE TABLE candidates (
  id                           TEXT PRIMARY KEY,
  task_id                      TEXT NOT NULL REFERENCES tasks(id),
  submission_id                TEXT NOT NULL REFERENCES submissions(id),
  outcome                      TEXT NOT NULL CHECK (outcome IN ('computed', 'conflict', 'stale-base', 'stale-head', 'error')),
  candidate_sha                TEXT,
  base_sha                     TEXT NOT NULL,
  candidate_ref                TEXT,
  check_identity               TEXT NOT NULL,
  check_policy                 TEXT NOT NULL CHECK (json_valid(check_policy) AND json_type(check_policy) = 'object'),
  conflict_files               TEXT CHECK (conflict_files IS NULL OR (json_valid(conflict_files) AND json_type(conflict_files) = 'array')),
  error_detail                 TEXT,
  compute_run_id               TEXT NOT NULL UNIQUE,
  recomputed_from_candidate_id TEXT REFERENCES candidates(id),
  recompute_reason             TEXT CHECK (recompute_reason IN (
                                 'base-move', 'raced', 'fence-released', 'staged-after-landing', 'manual')),
  computed_at                  TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  -- attempt status (mutable)
  status                       TEXT NOT NULL CHECK (status IN (
                                 'active', 'fenced', 'landed', 'raced', 'stale', 'superseded',
                                 'withdrawn', 'rejected', 'failed')),
  status_changed_at            TEXT NOT NULL,
  status_reason                TEXT,
  status_ref                   TEXT,
  CHECK ((outcome = 'computed') = (candidate_sha IS NOT NULL)),
  CHECK ((outcome = 'computed') = (candidate_ref IS NOT NULL)),
  CHECK ((outcome = 'conflict') = (conflict_files IS NOT NULL)),
  CHECK (outcome = 'computed' OR status = 'failed'),
  CHECK ((recomputed_from_candidate_id IS NULL) = (recompute_reason IS NULL))
);

CREATE INDEX candidates_by_task ON candidates(task_id, created_at);
CREATE INDEX candidates_by_submission ON candidates(submission_id);
CREATE UNIQUE INDEX candidates_one_live_per_task ON candidates(task_id) WHERE status IN ('active', 'fenced');

CREATE TABLE candidate_status_transitions (
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, PRIMARY KEY (from_status, to_status)
);
INSERT INTO candidate_status_transitions VALUES
  ('active', 'fenced'), ('active', 'superseded'), ('active', 'stale'),
  ('active', 'withdrawn'), ('active', 'rejected'),
  ('fenced', 'landed'), ('fenced', 'raced'), ('fenced', 'failed'),
  ('fenced', 'stale'), ('fenced', 'active');

CREATE TRIGGER candidates_immutable_fields
BEFORE UPDATE OF id, task_id, submission_id, outcome, candidate_sha, base_sha, candidate_ref,
                 check_identity, check_policy, conflict_files, error_detail, compute_run_id,
                 recomputed_from_candidate_id, recompute_reason, computed_at, created_at ON candidates
BEGIN SELECT RAISE(ABORT, 'candidates: only status columns may change'); END;

CREATE TRIGGER candidates_status_transition
BEFORE UPDATE OF status ON candidates
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM candidate_status_transitions WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'candidates: status transition not allowed'); END;

CREATE TRIGGER candidates_no_delete BEFORE DELETE ON candidates
BEGIN SELECT RAISE(ABORT, 'candidates are never deleted'); END;

-- Check runs are append-only; a rerun is a new row, the candidate row never changes.
CREATE TABLE candidate_checks (
  id              TEXT PRIMARY KEY,
  candidate_id    TEXT NOT NULL REFERENCES candidates(id),
  check_identity  TEXT NOT NULL,
  run_id          TEXT NOT NULL UNIQUE,
  result          TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'error', 'skipped')),
  evidence        TEXT NOT NULL CHECK (json_valid(evidence) AND json_type(evidence) = 'object'),
  started_at      TEXT NOT NULL,
  finished_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL
);

CREATE INDEX candidate_checks_by_candidate ON candidate_checks(candidate_id, recorded_at);

CREATE TRIGGER candidate_checks_no_update BEFORE UPDATE ON candidate_checks
BEGIN SELECT RAISE(ABORT, 'candidate_checks are immutable'); END;
CREATE TRIGGER candidate_checks_no_delete BEFORE DELETE ON candidate_checks
BEGIN SELECT RAISE(ABORT, 'candidate_checks are never deleted'); END;

-- ---------------------------------------------------------------------------
-- 6. Approvals
-- ---------------------------------------------------------------------------

CREATE TABLE approvals (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  candidate_id           TEXT NOT NULL REFERENCES candidates(id),
  approved_by            TEXT NOT NULL,
  approved_at            TEXT NOT NULL,
  bound_candidate_sha    TEXT NOT NULL,
  bound_base_sha         TEXT NOT NULL,
  bound_intent_version   INTEGER NOT NULL,
  note                   TEXT,
  idempotency_key        TEXT UNIQUE,
  -- active status (mutable). Validity lives here and nowhere else.
  status                 TEXT NOT NULL CHECK (status IN ('active', 'fenced', 'consumed', 'invalidated')),
  status_changed_at      TEXT NOT NULL,
  invalidation_reason    TEXT CHECK (invalidation_reason IN (
                           'submission', 'base-move', 'intent-edit', 'withdrawn', 'task-closed',
                           'landing-raced', 'landing-conflict')),
  invalidation_ref       TEXT,
  FOREIGN KEY (task_id, bound_intent_version) REFERENCES intents(task_id, version),
  CHECK ((status = 'invalidated') = (invalidation_reason IS NOT NULL))
);

CREATE INDEX approvals_by_task ON approvals(task_id, approved_at);
CREATE UNIQUE INDEX approvals_one_live_per_candidate ON approvals(candidate_id) WHERE status IN ('active', 'fenced');

CREATE TABLE approval_status_transitions (
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, PRIMARY KEY (from_status, to_status)
);
INSERT INTO approval_status_transitions VALUES
  ('active', 'fenced'), ('active', 'invalidated'),
  ('fenced', 'consumed'), ('fenced', 'invalidated'), ('fenced', 'active');

CREATE TRIGGER approvals_immutable_fields
BEFORE UPDATE OF id, task_id, candidate_id, approved_by, approved_at, bound_candidate_sha,
                 bound_base_sha, bound_intent_version, note, idempotency_key ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals: only status columns may change'); END;

CREATE TRIGGER approvals_status_transition
BEFORE UPDATE OF status ON approvals
FOR EACH ROW WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM approval_status_transitions WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'approvals: status transition not allowed'); END;

CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are never deleted'); END;

-- ---------------------------------------------------------------------------
-- 7. Landing fence
-- ---------------------------------------------------------------------------

-- The committed authorization. Acquired atomically with the tuple validation; while held,
-- newer intent edits and submissions are staged (see staged_behind_fence_id) and do not
-- touch the fenced approval. Released only after reconciliation against canonical.
CREATE TABLE landing_fences (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  candidate_id       TEXT NOT NULL REFERENCES candidates(id),
  approval_id        TEXT NOT NULL REFERENCES approvals(id),
  candidate_sha      TEXT NOT NULL,
  base_sha           TEXT NOT NULL,
  intent_version     INTEGER NOT NULL,
  requested_by_type  TEXT NOT NULL CHECK (requested_by_type IN ('human', 'agent', 'system')),
  requested_by_id    TEXT NOT NULL,
  integrator_run_id  TEXT NOT NULL UNIQUE,
  idempotency_key    TEXT UNIQUE,
  fenced_at          TEXT NOT NULL,
  -- mutable
  status             TEXT NOT NULL CHECK (status IN ('held', 'released')),
  resolution         TEXT CHECK (resolution IN ('landed', 'raced', 'conflict', 'error')),
  resolved_at        TEXT,
  reconciled_at      TEXT,
  released_at        TEXT,
  CHECK ((status = 'released') = (released_at IS NOT NULL)),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
  CHECK (status = 'held' OR (resolution IS NOT NULL AND reconciled_at IS NOT NULL))
);

CREATE INDEX landing_fences_by_task ON landing_fences(task_id, fenced_at);
CREATE UNIQUE INDEX landing_fences_one_held_per_task ON landing_fences(task_id) WHERE status = 'held';

CREATE TRIGGER landing_fences_immutable_fields
BEFORE UPDATE OF id, task_id, candidate_id, approval_id, candidate_sha, base_sha, intent_version,
                 requested_by_type, requested_by_id, integrator_run_id, idempotency_key, fenced_at ON landing_fences
BEGIN SELECT RAISE(ABORT, 'landing_fences: only resolution/release columns may change'); END;

CREATE TRIGGER landing_fences_release_once
BEFORE UPDATE OF status, resolution, resolved_at, reconciled_at, released_at ON landing_fences
FOR EACH ROW WHEN OLD.status = 'released'
BEGIN SELECT RAISE(ABORT, 'landing_fences: a released fence never changes'); END;

CREATE TRIGGER landing_fences_resolution_once
BEFORE UPDATE OF resolution ON landing_fences
FOR EACH ROW WHEN OLD.resolution IS NOT NULL AND NEW.resolution IS NOT OLD.resolution
BEGIN SELECT RAISE(ABORT, 'landing_fences: resolution is write-once'); END;

CREATE TRIGGER landing_fences_no_delete BEFORE DELETE ON landing_fences
BEGIN SELECT RAISE(ABORT, 'landing_fences are never deleted'); END;

-- ---------------------------------------------------------------------------
-- 8. Landing receipts
-- ---------------------------------------------------------------------------

-- One receipt per fence, written when the integrator reports and the control plane has
-- reconciled against canonical. Immutable. outcome = 'landed' rows are accepted results.
CREATE TABLE landing_receipts (
  id                      TEXT PRIMARY KEY,
  fence_id                TEXT NOT NULL UNIQUE REFERENCES landing_fences(id),
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  candidate_id            TEXT NOT NULL REFERENCES candidates(id),
  approval_id             TEXT NOT NULL REFERENCES approvals(id),
  repository_id           TEXT NOT NULL,
  target_ref              TEXT NOT NULL,
  candidate_sha           TEXT NOT NULL,
  intent_version          INTEGER NOT NULL,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('landed', 'raced', 'conflict', 'error')),
  landed_sha              TEXT,
  base_sha_before         TEXT NOT NULL,
  base_sha_after          TEXT NOT NULL,
  conflict_files          TEXT CHECK (conflict_files IS NULL OR (json_valid(conflict_files) AND json_type(conflict_files) = 'array')),
  error_detail            TEXT,
  integrator_run_id       TEXT NOT NULL UNIQUE,
  reconciled_against_sha  TEXT NOT NULL,
  reconciled_at           TEXT NOT NULL,
  ancestry_verified       INTEGER NOT NULL CHECK (ancestry_verified IN (0, 1)),
  -- JSON array of push_observations.event_id consumed to confirm this landing
  event_ids_consumed      TEXT NOT NULL CHECK (json_valid(event_ids_consumed) AND json_type(event_ids_consumed) = 'array'),
  created_at              TEXT NOT NULL,
  FOREIGN KEY (repository_id, target_ref) REFERENCES target_refs(repository_id, ref_name),
  CHECK ((outcome = 'landed') = (landed_sha IS NOT NULL)),
  CHECK (outcome <> 'landed' OR ancestry_verified = 1),
  CHECK (outcome <> 'raced' OR base_sha_before <> base_sha_after),
  CHECK ((outcome = 'conflict') = (conflict_files IS NOT NULL)),
  CHECK (base_sha_after = reconciled_against_sha)
);

CREATE INDEX landing_receipts_by_task ON landing_receipts(task_id, created_at);
CREATE INDEX landing_receipts_by_target ON landing_receipts(repository_id, target_ref, created_at);

CREATE TRIGGER landing_receipts_no_update BEFORE UPDATE ON landing_receipts
BEGIN SELECT RAISE(ABORT, 'landing_receipts are immutable'); END;
CREATE TRIGGER landing_receipts_no_delete BEFORE DELETE ON landing_receipts
BEGIN SELECT RAISE(ABORT, 'landing_receipts are never deleted'); END;

-- ---------------------------------------------------------------------------
-- 9. Audit log (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'integrator', 'system')),
  actor_id         TEXT NOT NULL,
  project_id       TEXT REFERENCES projects(id),
  task_id          TEXT REFERENCES tasks(id),
  type             TEXT NOT NULL CHECK (type IN (
    'project.created', 'repository.registered', 'target_ref.registered', 'target_ref.head_observed',
    'task.created', 'task.dependency_added', 'task.dependency_removed', 'task.published',
    'task.ready', 'task.unready', 'task.rejected', 'task.superseded',
    'intent.edited', 'intent.edit_staged',
    'claim.attempted', 'claim.granted', 'claim.released', 'claim.revoked', 'claim.superseded', 'claim.completed',
    'mapping.created', 'mapping.retired',
    'observation.recorded', 'observation.flagged',
    'submission.created', 'submission.staged',
    'candidate.computed', 'candidate.blocked', 'candidate.check_recorded',
    'candidate.superseded', 'candidate.stale', 'candidate.withdrawn', 'candidate.rejected',
    'approval.recorded', 'approval.invalidated', 'approval.fenced', 'approval.consumed', 'approval.reactivated',
    'landing.fenced', 'landing.dispatched', 'landing.resolved', 'landing.reconciled', 'landing.fence_released',
    'landing.staged_applied', 'task.landed', 'dependents.reevaluated',
    'webhook.created', 'webhook.replay_requested', 'webhook.disabled', 'webhook.reactivated',
    'webhook.attempt_started', 'webhook.attempt_recorded')),
  -- JSON object of ids and shas this row refers to, e.g.
  -- { "submissionId": "...", "candidateId": "...", "approvalId": "...", "fenceId": "...",
  --   "receiptId": "...", "claimId": "...", "intentVersion": 3, "sourceSha": "...",
  --   "baseSha": "...", "candidateSha": "...", "landedSha": "...", "eventIds": [...] }
  refs             TEXT NOT NULL CHECK (json_valid(refs) AND json_type(refs) = 'object'),
  idempotency_key  TEXT UNIQUE
);

CREATE INDEX audit_log_by_task ON audit_log(task_id, id);
CREATE INDEX audit_log_by_project ON audit_log(project_id, id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ---------------------------------------------------------------------------
-- 10. Views used by the admission rule and the fence validation
-- ---------------------------------------------------------------------------

-- Per dependency edge: is the upstream landed with an accepted result?
CREATE VIEW v_task_dependency_state AS
SELECT
  d.task_id,
  d.depends_on_task_id        AS upstream_task_id,
  u.status                    AS upstream_status,
  u.accepted_receipt_id       AS accepted_receipt_id,
  r.landed_sha                AS landed_sha,
  (u.status = 'landed' AND u.accepted_receipt_id IS NOT NULL) AS satisfied
FROM task_dependencies d
JOIN tasks u ON u.id = d.depends_on_task_id
LEFT JOIN landing_receipts r ON r.id = u.accepted_receipt_id;

-- Per task: admissible iff every upstream edge is satisfied (tasks without edges are admissible).
CREATE VIEW v_task_admission AS
SELECT
  t.id AS task_id,
  NOT EXISTS (SELECT 1 FROM v_task_dependency_state s WHERE s.task_id = t.id AND NOT s.satisfied) AS admissible,
  (SELECT COUNT(*) FROM v_task_dependency_state s WHERE s.task_id = t.id AND NOT s.satisfied) AS unlanded_upstreams
FROM tasks t;

-- The live attempt per task: active claim, live candidate, live approval, held fence.
CREATE VIEW v_task_live_attempt AS
SELECT
  t.id AS task_id,
  t.status AS task_status,
  t.current_intent_version,
  (SELECT c.id FROM claims c WHERE c.task_id = t.id AND c.result = 'granted' AND c.status = 'active') AS active_claim_id,
  (SELECT MAX(s.seq) FROM submissions s WHERE s.task_id = t.id) AS latest_submission_seq,
  (SELECT k.id FROM candidates k WHERE k.task_id = t.id AND k.status IN ('active', 'fenced')) AS live_candidate_id,
  (SELECT a.id FROM approvals a JOIN candidates k ON k.id = a.candidate_id
     WHERE k.task_id = t.id AND a.status IN ('active', 'fenced')) AS live_approval_id,
  (SELECT f.id FROM landing_fences f WHERE f.task_id = t.id AND f.status = 'held') AS held_fence_id
FROM tasks t;
