ALTER TABLE lineage_published_pointer ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE lineage_revision ADD COLUMN expected_pointer_version INTEGER NOT NULL DEFAULT 0 CHECK (expected_pointer_version >= 0);

CREATE TRIGGER lineage_revision_publish_pointer_guard
BEFORE INSERT ON lineage_revision
WHEN NEW.state = 'published'
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.expected_pointer_version = 0 AND NOT EXISTS (
      SELECT 1 FROM lineage_published_pointer WHERE lineage_id = NEW.lineage_id
    ))
    OR EXISTS (
      SELECT 1 FROM lineage_published_pointer
      WHERE lineage_id = NEW.lineage_id AND version = NEW.expected_pointer_version
    )
  ) THEN RAISE(ABORT, 'lineage publish conflict') END;
END;
