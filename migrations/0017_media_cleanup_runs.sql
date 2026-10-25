-- Cleanup execution is deliberately absent from this migration. These tables
-- only preserve an operator-reviewed, bounded candidate snapshot and an
-- independent second confirmation for a future separately approved executor.
CREATE TABLE media_cleanup_run (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending_confirmation', 'confirmed', 'cancelled', 'expired')),
  candidate_snapshot_sha256 TEXT NOT NULL CHECK (length(candidate_snapshot_sha256) = 64 AND candidate_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 100),
  backup_recovery_point TEXT NOT NULL CHECK (length(backup_recovery_point) BETWEEN 1 AND 255),
  backup_package_sha256 TEXT NOT NULL CHECK (length(backup_package_sha256) = 64 AND backup_package_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  confirmed_at TEXT,
  cancelled_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  cancelled_at TEXT,
  CHECK (expires_at > created_at),
  CHECK ((state = 'pending_confirmation' AND confirmed_by_account_id IS NULL AND confirmed_at IS NULL AND cancelled_by_account_id IS NULL AND cancelled_at IS NULL)
    OR (state = 'confirmed' AND confirmed_by_account_id IS NOT NULL AND confirmed_by_account_id <> created_by_account_id AND confirmed_at IS NOT NULL AND cancelled_by_account_id IS NULL AND cancelled_at IS NULL)
    OR (state = 'cancelled' AND confirmed_by_account_id IS NULL AND confirmed_at IS NULL AND cancelled_by_account_id IS NOT NULL AND cancelled_at IS NOT NULL)
    OR (state = 'expired' AND confirmed_by_account_id IS NULL AND confirmed_at IS NULL AND cancelled_by_account_id IS NULL AND cancelled_at IS NULL))
);
CREATE INDEX media_cleanup_run_state_expires ON media_cleanup_run(state, expires_at, id);

CREATE TABLE media_cleanup_item (
  id TEXT PRIMARY KEY,
  cleanup_run_id TEXT NOT NULL REFERENCES media_cleanup_run(id) ON DELETE RESTRICT,
  media_asset_id TEXT NOT NULL REFERENCES media_asset(id) ON DELETE RESTRICT,
  expected_object_key TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_byte_size INTEGER NOT NULL CHECK (expected_byte_size > 0),
  expected_retired_at TEXT NOT NULL,
  expected_cleanup_after TEXT NOT NULL,
  expected_historical_link_count INTEGER NOT NULL CHECK (expected_historical_link_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('frozen', 'skipped_changed', 'r2_deleted_pending_finalize', 'purged', 'failed')),
  error_code TEXT,
  r2_deleted_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(cleanup_run_id, media_asset_id),
  CHECK ((state = 'frozen' AND error_code IS NULL AND r2_deleted_at IS NULL AND finalized_at IS NULL)
    OR (state = 'skipped_changed' AND error_code IS NOT NULL AND r2_deleted_at IS NULL AND finalized_at IS NOT NULL)
    OR (state = 'r2_deleted_pending_finalize' AND error_code IS NOT NULL AND r2_deleted_at IS NOT NULL AND finalized_at IS NULL)
    OR (state = 'purged' AND error_code IS NULL AND r2_deleted_at IS NOT NULL AND finalized_at IS NOT NULL)
    OR (state = 'failed' AND error_code IS NOT NULL AND r2_deleted_at IS NULL AND finalized_at IS NOT NULL))
);
CREATE INDEX media_cleanup_item_run_state ON media_cleanup_item(cleanup_run_id, state, id);
