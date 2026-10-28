-- A freeze advances the write epoch atomically with its creation. Existing
-- admissions get epoch 0, which cannot satisfy the new guarded write path.
CREATE TABLE backup_write_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL CHECK (epoch > 0)
);
INSERT INTO backup_write_epoch (id, epoch) VALUES (1, 1);
ALTER TABLE backup_write_admission ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0);
CREATE TRIGGER backup_write_freeze_advance_epoch
AFTER INSERT ON backup_write_freeze
BEGIN
  UPDATE backup_write_epoch SET epoch = epoch + 1 WHERE id = 1;
END;
