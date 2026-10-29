-- Transaction-local assertion: never retains rows. A stale admission aborts
-- the whole D1 batch before any business statement executes.
CREATE TABLE backup_write_fence_check (admission_id TEXT NOT NULL);
CREATE TRIGGER backup_write_fence_check_guard BEFORE INSERT ON backup_write_fence_check
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM backup_write_admission AS admission
    JOIN backup_write_epoch AS current ON current.id = 1 AND current.epoch = admission.epoch
    WHERE admission.id = NEW.admission_id AND admission.completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM backup_write_freeze WHERE released_at IS NULL)
  ) THEN RAISE(ABORT, 'backup_write_epoch_stale') END;
  SELECT RAISE(IGNORE);
END;
