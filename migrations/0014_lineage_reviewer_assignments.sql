-- Explicit, expiring reviewer assignments. They are independent of editor
-- account_scope and are never inferred from branch membership or genealogy.
CREATE TABLE lineage_reviewer_assignment (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL REFERENCES lineage(id) ON DELETE RESTRICT,
  reviewer_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  granted_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  revoke_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (valid_from < valid_until),
  CHECK ((revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX lineage_reviewer_assignment_effective ON lineage_reviewer_assignment(lineage_id, valid_from, valid_until, reviewer_account_id);

-- Submission captures the eligible reviewers. Later revoke/expiry is checked
-- again at review and publish time; the snapshot explains who was responsible
-- when the proposal entered review.
CREATE TABLE change_request_reviewer_assignment (
  change_request_id TEXT NOT NULL REFERENCES change_request(id) ON DELETE RESTRICT,
  reviewer_assignment_id TEXT NOT NULL REFERENCES lineage_reviewer_assignment(id) ON DELETE RESTRICT,
  reviewer_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (change_request_id, reviewer_assignment_id)
);
CREATE INDEX change_request_reviewer_account ON change_request_reviewer_assignment(change_request_id, reviewer_account_id);
