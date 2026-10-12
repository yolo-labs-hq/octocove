-- ADR 0019: a sign-in (auth_families row) lives up to a sliding idle expiry, pushed forward by
-- each session renewal and never past `absolute_expiry`, which stays the hard cap. Session tokens stay 30 minutes.
-- auth_families and auth_sessions keep their columns: the new state lives in two side tables keyed by them.

-- A family's idle expiry. A family with no row (one written by a Worker still on the previous version while this
-- migration applies) reads as idle_expiry = absolute_expiry: never longer than before. The backfill writes exactly
-- that for every existing family, so a live eight-hour sign-in keeps its current deadline and is not extended; only
-- sign-ins created from now on get the longer lifetime. Readers still cap it by absolute_expiry.
CREATE TABLE auth_family_idle (
 family_id TEXT PRIMARY KEY REFERENCES auth_families(id),
 idle_expiry INTEGER NOT NULL
);
INSERT INTO auth_family_idle(family_id, idle_expiry) SELECT id, absolute_expiry FROM auth_families;

-- When a renewal rotated a session token away (written in the renewal's batch, with revoked=1 on the session row).
-- A token presented to renewal after it was rotated away (outside the same-key recovery window) is reuse: the whole
-- family is revoked. A token revoked any other way (logout, self-service revoke) has no row; neither do tokens
-- revoked before this migration, as nothing recorded why.
CREATE TABLE auth_session_rotations (
 hash TEXT PRIMARY KEY REFERENCES auth_sessions(hash),
 rotated_at INTEGER NOT NULL
);

-- Why a family was revoked with an audit row. Existing rows are all self-service revocations
-- (POST /me/sessions/{id}/revoke). `token-reuse` rows are written by renewal's reuse detection, with
-- actor_family_id = family_id and current = 1: the presenting credential belongs to the family it revokes.
ALTER TABLE auth_family_revocations ADD COLUMN reason TEXT NOT NULL DEFAULT 'self-service'
  CHECK (reason IN ('self-service', 'token-reuse'));
