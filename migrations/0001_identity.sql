PRAGMA foreign_keys = ON;

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_scheme TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE role (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL
);

CREATE TABLE permission (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL
);

CREATE TABLE role_permission (
  role_id TEXT NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
  permission_id TEXT NOT NULL REFERENCES permission(id) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE account_role (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  role_id TEXT NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
  granted_at TEXT NOT NULL,
  granted_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  PRIMARY KEY (account_id, role_id)
);

CREATE TABLE account_scope (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'branch', 'person')),
  scope_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type <> 'global' AND scope_id IS NOT NULL))
);

CREATE UNIQUE INDEX account_scope_unique ON account_scope(account_id, scope_type, scope_id);

CREATE TABLE auth_session (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  csrf_secret_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX auth_session_account_active ON auth_session(account_id, expires_at) WHERE revoked_at IS NULL;
