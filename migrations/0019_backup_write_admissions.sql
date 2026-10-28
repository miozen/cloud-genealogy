-- Admissions are never automatically expired: a crashed request requires
-- investigation, not an optimistic assumption that its writes stopped.
CREATE TABLE backup_write_admission (
  id TEXT PRIMARY KEY,
  admitted_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX backup_write_admission_open ON backup_write_admission(completed_at) WHERE completed_at IS NULL;
