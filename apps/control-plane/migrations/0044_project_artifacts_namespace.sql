-- ADR 0017: one Artifacts namespace per project. Only holders of the deployment's account-wide
-- Artifacts API token (the operator and the control plane) can create repositories in a namespace; users and agents
-- only ever hold repo-scoped Git tokens, which cannot cross repositories or namespaces. A namespace assigned to one
-- project alone therefore holds only that project's repositories, and registration and verification require it.
--
-- The name is `oc-<projectId>` (projects.ts, projectNamespace, the one builder in code). The two SQL copies below,
-- the backfill and the insert default, are tested against it (project-namespace-upgrade.test.ts and
-- project-create.test.ts). It is derived from the immutable project id, never the slug.
ALTER TABLE projects ADD COLUMN artifacts_namespace TEXT;
-- Artifacts' namespace rules: 2-63 characters, first a letter or digit, then letters, digits, `.`, `_`, `-`. And the
-- name is derived, never chosen: any non-NULL namespace a write stores, on insert or update, is exactly `oc-<id>`
-- (an explicit insert cannot name a project's namespace after anything else). The shape is checked first, so an id
-- that cannot name a namespace reports the shape.
CREATE TRIGGER projects_artifacts_namespace_shape BEFORE UPDATE OF artifacts_namespace, id ON projects
WHEN NEW.artifacts_namespace IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'projects: invalid artifacts namespace') WHERE length(NEW.artifacts_namespace) NOT BETWEEN 2 AND 63
  OR NEW.artifacts_namespace GLOB '*[^A-Za-z0-9._-]*' OR substr(NEW.artifacts_namespace,1,1) GLOB '[^A-Za-z0-9]';
 SELECT RAISE(ABORT,'projects: artifacts namespace must be oc-<id>') WHERE NEW.artifacts_namespace IS NOT 'oc-'||NEW.id;
END;
CREATE TRIGGER projects_artifacts_namespace_shape_insert BEFORE INSERT ON projects
WHEN NEW.artifacts_namespace IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'projects: invalid artifacts namespace') WHERE length(NEW.artifacts_namespace) NOT BETWEEN 2 AND 63
  OR NEW.artifacts_namespace GLOB '*[^A-Za-z0-9._-]*' OR substr(NEW.artifacts_namespace,1,1) GLOB '[^A-Za-z0-9]';
 SELECT RAISE(ABORT,'projects: artifacts namespace must be oc-<id>') WHERE NEW.artifacts_namespace IS NOT 'oc-'||NEW.id;
END;
-- No replacing insert (0041's `repositories_no_replace` pattern): `INSERT OR REPLACE` with an existing id or slug
-- would delete that project row without its DELETE triggers (so without retiring its namespace) and write another
-- in its place. A project's id, slug and namespace are created once, by a plain insert.
CREATE TRIGGER projects_no_replace BEFORE INSERT ON projects
WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.id OR slug=NEW.slug)
BEGIN SELECT RAISE(ABORT,'projects: duplicate immutable identity'); END;

-- Every existing project gets its name now, after the shape triggers, so an existing id that cannot name a
-- namespace fails the migration rather than storing an unusable name. Ids of API-created projects are UUIDs, so
-- their names are 39 characters.
UPDATE projects SET artifacts_namespace='oc-'||id WHERE artifacts_namespace IS NULL;
CREATE UNIQUE INDEX projects_artifacts_namespace ON projects(artifacts_namespace);

-- Immutable once set, like 0041's identity triggers: neither the namespace nor the id it derives from may change.
CREATE TRIGGER projects_artifacts_namespace_immutable BEFORE UPDATE OF artifacts_namespace, id ON projects
WHEN OLD.artifacts_namespace IS NOT NULL AND (NEW.artifacts_namespace IS NOT OLD.artifacts_namespace OR NEW.id<>OLD.id)
BEGIN SELECT RAISE(ABORT,'projects: artifacts namespace is immutable once set'); END;

-- A row inserted without a namespace (seeds and fixtures that list only the original five columns) gets its
-- deterministic one, so every project has a namespace. createProject always writes it explicitly.
CREATE TRIGGER projects_artifacts_namespace_default AFTER INSERT ON projects WHEN NEW.artifacts_namespace IS NULL
BEGIN UPDATE projects SET artifacts_namespace='oc-'||NEW.id WHERE id=NEW.id; END;

-- Never reused: a deleted project's namespace may still hold its repositories (Artifacts does not cascade a
-- namespace delete), so it is retired for good. Nothing deletes projects today; this keeps it true if something does.
CREATE TABLE retired_artifacts_namespaces (namespace TEXT PRIMARY KEY, project_id TEXT NOT NULL, retired_at TEXT NOT NULL);
CREATE TRIGGER retired_artifacts_namespaces_no_update BEFORE UPDATE ON retired_artifacts_namespaces
BEGIN SELECT RAISE(ABORT,'retired_artifacts_namespaces is append-only'); END;
CREATE TRIGGER retired_artifacts_namespaces_no_delete BEFORE DELETE ON retired_artifacts_namespaces
BEGIN SELECT RAISE(ABORT,'retired_artifacts_namespaces is append-only'); END;
CREATE TRIGGER projects_artifacts_namespace_retire AFTER DELETE ON projects WHEN OLD.artifacts_namespace IS NOT NULL
BEGIN INSERT INTO retired_artifacts_namespaces(namespace,project_id,retired_at)
 VALUES(OLD.artifacts_namespace,OLD.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER projects_artifacts_namespace_not_retired BEFORE INSERT ON projects
WHEN EXISTS(SELECT 1 FROM retired_artifacts_namespaces WHERE namespace=NEW.artifacts_namespace OR namespace='oc-'||NEW.id)
BEGIN SELECT RAISE(ABORT,'projects: artifacts namespace was retired'); END;
CREATE TRIGGER projects_artifacts_namespace_not_retired_update BEFORE UPDATE OF artifacts_namespace ON projects
WHEN EXISTS(SELECT 1 FROM retired_artifacts_namespaces WHERE namespace=NEW.artifacts_namespace)
BEGIN SELECT RAISE(ABORT,'projects: artifacts namespace was retired'); END;
