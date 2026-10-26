-- A short, auditable logical write freeze establishes the D1/R2 consistency
-- window for an operator-run backup. It is intentionally a single active
-- record: concurrent backup windows would make the audit trail ambiguous.
CREATE TABLE backup_write_freeze (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  released_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  released_at TEXT,
  release_reason TEXT,
  CHECK ((released_at IS NULL AND released_by_account_id IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by_account_id IS NOT NULL AND length(release_reason) BETWEEN 1 AND 1000))
);

CREATE UNIQUE INDEX backup_write_freeze_one_active ON backup_write_freeze((1)) WHERE released_at IS NULL;
CREATE INDEX backup_write_freeze_active_created ON backup_write_freeze(released_at, created_at, id);
