






CREATE TABLE notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 recipient_issuer TEXT NOT NULL,
 recipient_sub TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('review-requested', 'approval-invalidated', 'landed', 'candidate-blocked',
   'claim-ended', 'repository-needs-operator', 'member-added')),
 project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT REFERENCES tasks(id),
 event_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 read_at TEXT,
 UNIQUE (recipient_issuer, recipient_sub, event_id, kind)
);
CREATE INDEX notifications_by_recipient ON notifications(recipient_issuer, recipient_sub, created_at);
CREATE INDEX notifications_unread ON notifications(recipient_issuer, recipient_sub, id) WHERE read_at IS NULL;

CREATE INDEX notifications_by_created ON notifications(created_at);

CREATE TABLE notification_preferences (
 recipient_issuer TEXT NOT NULL,
 recipient_sub TEXT NOT NULL,
 muted_kinds TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(muted_kinds) AND json_type(muted_kinds) = 'array'),
 muted_projects TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(muted_projects) AND json_type(muted_projects) = 'array'),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (recipient_issuer, recipient_sub)
);



CREATE TABLE notification_projector (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 cursor INTEGER NOT NULL
);
INSERT INTO notification_projector(id, cursor) SELECT 1, COALESCE(MAX(id), 0) FROM audit_log;
