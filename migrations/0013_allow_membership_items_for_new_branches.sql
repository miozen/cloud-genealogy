-- A membership proposal may target a branch created by another item in the
-- same change request. The current branch row does not exist until publish,
-- so this proposal-layer column must not reference branch(id). Publication
-- still validates the projected structure and writes snapshot rows only after
-- the branch creation statement in its single D1 batch.
ALTER TABLE branch_membership_change_item RENAME TO branch_membership_change_item_legacy;

CREATE TABLE branch_membership_change_item (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_request(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
  branch_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  membership_kind TEXT NOT NULL CHECK (membership_kind IN ('blood_primary', 'migration', 'administrative')),
  created_at TEXT NOT NULL,
  UNIQUE (change_request_id, operation, branch_id, person_id, membership_kind)
);

INSERT INTO branch_membership_change_item (id, change_request_id, operation, branch_id, person_id, membership_kind, created_at)
SELECT id, change_request_id, operation, branch_id, person_id, membership_kind, created_at
FROM branch_membership_change_item_legacy;

DROP TABLE branch_membership_change_item_legacy;

CREATE INDEX branch_membership_change_item_request ON branch_membership_change_item(change_request_id, id);
