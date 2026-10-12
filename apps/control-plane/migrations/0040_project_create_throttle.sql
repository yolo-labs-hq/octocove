-- Per-principal token bucket for POST /projects (src/projects.ts). One row per
-- creator principal (`issuer|sub`); `tokens` is the balance after the last admitted or refused attempt
-- at `updated_at` (unix seconds), `admitted` whether that attempt took a token. Throttle state only:
-- not audit, not a ledger, safe to delete.
CREATE TABLE project_create_throttle (
 principal TEXT PRIMARY KEY,
 tokens REAL NOT NULL,
 updated_at INTEGER NOT NULL,
 admitted INTEGER NOT NULL CHECK(admitted IN (0,1))
);
