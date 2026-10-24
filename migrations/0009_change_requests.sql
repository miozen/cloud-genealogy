CREATE TABLE change_request (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL REFERENCES lineage(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'pending_review', 'approved', 'rejected', 'published', 'conflicted')),
  base_revision_id TEXT REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  base_pointer_version INTEGER NOT NULL CHECK (base_pointer_version >= 0),
  reason TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  reviewed_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  review_note TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  reviewed_at TEXT,
  published_at TEXT
);
CREATE INDEX change_request_lineage_state ON change_request(lineage_id, state, created_at);

CREATE TABLE change_item (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_request(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('succession_add', 'succession_remove', 'relation_add', 'relation_remove')),
  subject_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  related_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  relation_kind TEXT CHECK (relation_kind IN ('biological_parent', 'adoptive_parent', 'successor_parent', 'spouse')),
  created_at TEXT NOT NULL,
  CHECK (subject_person_id <> related_person_id),
  CHECK ((operation IN ('succession_add', 'succession_remove') AND relation_kind IS NULL) OR (operation IN ('relation_add', 'relation_remove') AND relation_kind IS NOT NULL))
);
CREATE UNIQUE INDEX change_item_unique ON change_item(change_request_id, operation, subject_person_id, related_person_id, relation_kind);

ALTER TABLE lineage_revision ADD COLUMN change_request_id TEXT REFERENCES change_request(id) ON DELETE RESTRICT;
ALTER TABLE lineage_revision ADD COLUMN change_request_version INTEGER;

CREATE TRIGGER lineage_revision_change_request_guard
BEFORE INSERT ON lineage_revision
WHEN NEW.state = 'published' AND NEW.change_request_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM change_request
    WHERE id = NEW.change_request_id
      AND lineage_id = NEW.lineage_id
      AND state = 'approved'
      AND version = NEW.change_request_version
  ) THEN RAISE(ABORT, 'change request publish conflict') END;
END;
