-- Published revisions must retain the branch tree that gave their membership
-- snapshots meaning.  The current branch table alone cannot do that after a
-- later rename, move, or retirement.
CREATE TABLE branch_structure_snapshot (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  parent_branch_id TEXT,
  name TEXT NOT NULL,
  branch_kind TEXT NOT NULL CHECK (branch_kind IN ('agnatic', 'migration', 'administrative')),
  retired_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (revision_id, branch_id)
);
CREATE INDEX branch_structure_snapshot_parent ON branch_structure_snapshot(revision_id, parent_branch_id, name);

-- No public branch-structure writer existed before this migration, so the
-- current structure is the only available interpretation for prior snapshots.
INSERT INTO branch_structure_snapshot (id, revision_id, branch_id, parent_branch_id, name, branch_kind, retired_at, created_at)
SELECT r.id || ':branch-structure:' || b.id, r.id, b.id, b.parent_branch_id, b.name, b.branch_kind, b.retired_at, r.created_at
FROM lineage_revision r
JOIN branch b ON b.lineage_id = r.lineage_id;
