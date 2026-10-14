
CREATE TABLE binding_projection_outbox (
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES inbound_hint_bindings(source_id),
 generation INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('created','retired')),
 signed_content TEXT, object_sha TEXT, ref_name TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','exported','conflicted')),
 CHECK((signed_content IS NULL)=(object_sha IS NULL)),
 CHECK((signed_content IS NULL)=(ref_name IS NULL))
);
CREATE TRIGGER binding_projection_created AFTER INSERT ON inbound_hint_bindings
BEGIN
 INSERT INTO binding_projection_outbox(id,source_id,generation,reason)
 VALUES('binding-created-'||NEW.source_id,NEW.source_id,NEW.generation,'created');
END;
CREATE TRIGGER binding_projection_retired AFTER UPDATE OF retired_at ON inbound_hint_bindings
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
BEGIN
 INSERT INTO binding_projection_outbox(id,source_id,generation,reason)
 VALUES('binding-retired-'||NEW.source_id,NEW.source_id,NEW.generation,'retired');
END;
CREATE TRIGGER binding_projection_identity BEFORE UPDATE OF id,source_id,generation,reason ON binding_projection_outbox
BEGIN SELECT RAISE(ABORT,'binding projection identity immutable'); END;
CREATE TRIGGER binding_projection_content BEFORE UPDATE OF signed_content,object_sha,ref_name ON binding_projection_outbox
WHEN OLD.signed_content IS NOT NULL AND (NEW.signed_content IS NOT OLD.signed_content OR NEW.object_sha IS NOT OLD.object_sha OR NEW.ref_name IS NOT OLD.ref_name)
BEGIN SELECT RAISE(ABORT,'binding projection content immutable'); END;
CREATE TRIGGER binding_projection_no_delete BEFORE DELETE ON binding_projection_outbox
BEGIN SELECT RAISE(ABORT,'binding projection retained'); END;


CREATE TABLE binding_reattachments (
 source_id TEXT PRIMARY KEY REFERENCES inbound_hint_bindings(source_id),
 repository_id TEXT NOT NULL REFERENCES repositories(id), generation INTEGER NOT NULL,
 checkpoint_digest TEXT NOT NULL, journal_digest TEXT NOT NULL, local_repo TEXT NOT NULL,
 report_digest TEXT NOT NULL
);
