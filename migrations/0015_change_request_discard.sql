-- Discarded drafts remain auditable. They are never physically deleted and
-- cannot return to the submission workflow.
ALTER TABLE change_request ADD COLUMN discarded_at TEXT;
ALTER TABLE change_request ADD COLUMN discarded_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT;
CREATE INDEX change_request_discarded ON change_request(lineage_id, discarded_at, created_at);
