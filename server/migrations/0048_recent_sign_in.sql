






CREATE TABLE auth_family_created (
 family_id TEXT PRIMARY KEY REFERENCES auth_families(id),
 created_at INTEGER NOT NULL
);


ALTER TABLE auth_transactions ADD COLUMN reauth_family_id TEXT REFERENCES auth_families(id);
