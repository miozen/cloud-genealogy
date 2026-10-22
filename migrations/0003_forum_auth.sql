-- Forum-style identity activation.  This migration is intentionally applied
-- before real accounts exist; the replacement table lets the account status
-- CHECK constraint grow without weakening it.
PRAGMA foreign_keys = OFF;

CREATE TABLE account_next (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email TEXT COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  registration_branch_name TEXT,
  registration_ancestor_name TEXT,
  password_scheme TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'rejected')),
  reviewed_at TEXT,
  reviewed_by_account_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- There are no deployed accounts at this stage.  The fallback preserves any
-- future pre-migration local test records as active legacy identities.
INSERT INTO account_next (
  id, username, email, display_name, password_scheme, password_hash, status,
  version, created_at, updated_at
)
SELECT id, email, email, display_name,
       COALESCE(password_scheme, 'legacy-unusable'), COALESCE(password_hash, 'legacy-unusable'),
       status, version, created_at, updated_at
FROM account;

DROP TABLE account;
ALTER TABLE account_next RENAME TO account;

CREATE TABLE person (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'MEMBER' CHECK (visibility IN ('PUBLIC', 'MEMBER', 'ADMIN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- This is an administrator-confirmed identity association, not a name match.
CREATE TABLE account_person_link (
  account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  linked_at TEXT NOT NULL,
  linked_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT
);

CREATE INDEX account_person_link_person ON account_person_link(person_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_log_object_created_at ON audit_log(object_type, object_id, created_at);

INSERT INTO role (id, name, description) VALUES
  ('role-member', 'member', '已审核族人'),
  ('role-editor', 'editor', '可提交族谱修改建议的编辑员'),
  ('role-admin', 'admin', '系统管理员')
ON CONFLICT(name) DO NOTHING;

INSERT INTO permission (id, name, description) VALUES
  ('permission-system-manage', 'system.manage', '系统管理'),
  ('permission-lineage-review', 'lineage.review', '审核族谱变更'),
  ('permission-lineage-propose', 'lineage.propose', '提交族谱变更'),
  ('permission-person-read-member', 'person.read_member', '读取 MEMBER 级人物资料'),
  ('permission-person-read-admin', 'person.read_admin', '读取 ADMIN 级人物资料')
ON CONFLICT(name) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  ('role-member', 'permission-person-read-member'),
  ('role-editor', 'permission-person-read-member'),
  ('role-editor', 'permission-lineage-propose'),
  ('role-admin', 'permission-person-read-member'),
  ('role-admin', 'permission-person-read-admin'),
  ('role-admin', 'permission-lineage-propose'),
  ('role-admin', 'permission-lineage-review'),
  ('role-admin', 'permission-system-manage')
ON CONFLICT(role_id, permission_id) DO NOTHING;

CREATE UNIQUE INDEX account_scope_one_global ON account_scope(account_id) WHERE scope_type = 'global';

PRAGMA foreign_keys = ON;
