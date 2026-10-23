ALTER TABLE source_fact_claim ADD COLUMN retracted_at TEXT;
ALTER TABLE source_relation_claim ADD COLUMN retracted_at TEXT;

CREATE INDEX source_fact_claim_active ON source_fact_claim(edition_id, subject_record_id) WHERE retracted_at IS NULL;
CREATE INDEX source_relation_claim_active ON source_relation_claim(edition_id, subject_record_id) WHERE retracted_at IS NULL;
