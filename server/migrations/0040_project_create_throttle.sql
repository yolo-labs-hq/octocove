



CREATE TABLE project_create_throttle (
 principal TEXT PRIMARY KEY,
 tokens REAL NOT NULL,
 updated_at INTEGER NOT NULL,
 admitted INTEGER NOT NULL CHECK(admitted IN (0,1))
);
