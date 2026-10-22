CREATE TABLE auth_login_rate_limit (
  key_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX auth_login_rate_limit_updated_at ON auth_login_rate_limit(updated_at);
