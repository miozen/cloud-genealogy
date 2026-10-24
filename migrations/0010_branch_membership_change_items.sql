-- Membership is administrative data, not a relation edge.  Keep proposal
-- items separate so its review, preview and rollback semantics stay explicit.
CREATE TABLE branch_membership_change_item (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_request(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
  branch_id TEXT NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  membership_kind TEXT NOT NULL CHECK (membership_kind IN ('blood_primary', 'migration', 'administrative')),
  created_at TEXT NOT NULL,
  UNIQUE (change_request_id, operation, branch_id, person_id, membership_kind)
);
CREATE INDEX branch_membership_change_item_request ON branch_membership_change_item(change_request_id, id);
