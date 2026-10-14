







ALTER TABLE projects ADD COLUMN artifacts_namespace TEXT;

CREATE TRIGGER projects_artifacts_namespace_shape BEFORE UPDATE OF artifacts_namespace ON projects
WHEN NEW.artifacts_namespace IS NOT NULL AND (length(NEW.artifacts_namespace) NOT BETWEEN 2 AND 63
 OR NEW.artifacts_namespace GLOB '*[^A-Za-z0-9._-]*' OR substr(NEW.artifacts_namespace,1,1) GLOB '[^A-Za-z0-9]')
BEGIN SELECT RAISE(ABORT,'projects: invalid artifacts namespace'); END;
CREATE TRIGGER projects_artifacts_namespace_shape_insert BEFORE INSERT ON projects
WHEN NEW.artifacts_namespace IS NOT NULL AND (length(NEW.artifacts_namespace) NOT BETWEEN 2 AND 63
 OR NEW.artifacts_namespace GLOB '*[^A-Za-z0-9._-]*' OR substr(NEW.artifacts_namespace,1,1) GLOB '[^A-Za-z0-9]')
BEGIN SELECT RAISE(ABORT,'projects: invalid artifacts namespace'); END;



UPDATE projects SET artifacts_namespace='oc-'||id WHERE artifacts_namespace IS NULL;
CREATE UNIQUE INDEX projects_artifacts_namespace ON projects(artifacts_namespace);

CREATE TRIGGER projects_artifacts_namespace_immutable BEFORE UPDATE OF artifacts_namespace, id ON projects
WHEN OLD.artifacts_namespace IS NOT NULL AND (NEW.artifacts_namespace IS NOT OLD.artifacts_namespace OR NEW.id<>OLD.id)
BEGIN SELECT RAISE(ABORT,'projects: artifacts namespace is immutable once set'); END;


CREATE TRIGGER projects_artifacts_namespace_default AFTER INSERT ON projects WHEN NEW.artifacts_namespace IS NULL
BEGIN UPDATE projects SET artifacts_namespace='oc-'||NEW.id WHERE id=NEW.id; END;


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
