-- ADR 0023: sensitive actions need a sign-in that authenticated with the identity provider within
-- the last hour. Re-authenticating refreshes the same family instead of creating a new one.

-- `auth_families.authenticated_at` now means the family's latest OIDC authentication. A family's first one, when a
-- re-authentication replaced it, moves here (written in the re-authentication's batch, never overwritten). A family
-- without a row never re-authenticated: its `authenticated_at` is still its first. auth_families keeps its columns, as
-- 0046 did: Workers on the previous version and positional inserts are unaffected. `absolute_expiry` does not change on
-- re-authentication and stays the hard cap from the first sign-in.
CREATE TABLE auth_family_created (
 family_id TEXT PRIMARY KEY REFERENCES auth_families(id),
 created_at INTEGER NOT NULL
);

-- The family a browser login transaction re-authenticates (POST /v1/auth/login?reauth=1). NULL for every other login,
-- which creates a new family as before.
ALTER TABLE auth_transactions ADD COLUMN reauth_family_id TEXT REFERENCES auth_families(id);
