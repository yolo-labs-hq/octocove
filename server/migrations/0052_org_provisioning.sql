

CREATE TABLE org_provisioning (
 id TEXT PRIMARY KEY CHECK(id GLOB 'org_*'),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 creator_issuer TEXT NOT NULL,
 creator_sub TEXT NOT NULL,
 request_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 accepted_status INTEGER NOT NULL CHECK(accepted_status=202),
 accepted_body TEXT NOT NULL,
 created_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','failed')),
 stage TEXT NOT NULL DEFAULT 'queued' CHECK(stage IN ('queued','migrated','binding_deployed','verified','active')),
 admitted_day TEXT,
 daily_slot INTEGER CHECK(daily_slot BETWEEN 1 AND 20),
 database_id TEXT,
 worker_group TEXT,
 binding TEXT,
 schema_version INTEGER,
 routing_epoch INTEGER,
 UNIQUE(creator_issuer,creator_sub,request_key),
 UNIQUE(admitted_day,daily_slot),
 CHECK ((admitted_day IS NULL AND daily_slot IS NULL) OR (admitted_day IS NOT NULL AND daily_slot IS NOT NULL)),
 CHECK (state!='active' OR stage='active'),
 FOREIGN KEY (creator_issuer,creator_sub) REFERENCES auth_users(issuer,sub)
);
CREATE INDEX org_provisioning_queue ON org_provisioning(state,stage,created_at,id);
CREATE INDEX org_provisioning_creator ON org_provisioning(creator_issuer,creator_sub);
CREATE TABLE org_admins (
 org_id TEXT NOT NULL REFERENCES org_provisioning(id),
 issuer TEXT NOT NULL,
 sub TEXT NOT NULL,
 added_at TEXT NOT NULL,
 PRIMARY KEY(org_id,issuer,sub),
 FOREIGN KEY(issuer,sub) REFERENCES auth_users(issuer,sub)
);
