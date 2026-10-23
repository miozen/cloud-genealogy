-- Published revisions are immutable snapshots. The mutable current-version
-- choice lives in a separate pointer, so rollback can point at an old snapshot
-- without rewriting that snapshot.
DROP INDEX lineage_one_published_revision;

CREATE TABLE lineage_published_pointer (
  lineage_id TEXT PRIMARY KEY REFERENCES lineage(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);
