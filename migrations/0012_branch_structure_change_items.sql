-- Branch structure is independent from relation and membership proposals.
CREATE TABLE branch_structure_change_item (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_request(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'rename', 'retire')),
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  name TEXT NOT NULL,
  branch_kind TEXT CHECK (branch_kind IN ('agnatic', 'migration', 'administrative')),
  created_at TEXT NOT NULL,
  UNIQUE (change_request_id, operation, branch_id)
);
CREATE INDEX branch_structure_change_item_request ON branch_structure_change_item(change_request_id, id);
