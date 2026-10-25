-- Media objects are private, immutable R2 objects.  D1 is the authoritative
-- inventory for backup/restore; object keys never contain user-provided names.
CREATE TABLE media_asset (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'MEMBER', 'ADMIN')),
  state TEXT NOT NULL CHECK (state IN ('pending_upload', 'active', 'failed', 'retired')),
  created_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  upload_expires_at TEXT NOT NULL,
  finalized_at TEXT,
  failed_at TEXT,
  retired_at TEXT,
  cleanup_after TEXT,
  r2_etag TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  CHECK ((state = 'pending_upload' AND finalized_at IS NULL AND failed_at IS NULL AND retired_at IS NULL AND cleanup_after IS NULL)
    OR (state = 'active' AND finalized_at IS NOT NULL AND failed_at IS NULL AND retired_at IS NULL AND cleanup_after IS NULL)
    OR (state = 'failed' AND finalized_at IS NULL AND failed_at IS NOT NULL AND retired_at IS NULL AND cleanup_after IS NOT NULL)
    OR (state = 'retired' AND finalized_at IS NOT NULL AND failed_at IS NULL AND retired_at IS NOT NULL AND cleanup_after IS NOT NULL))
);
CREATE INDEX media_asset_state_cleanup ON media_asset(state, cleanup_after, id);
CREATE INDEX media_asset_created_by ON media_asset(created_by_account_id, created_at, id);

-- Keep the first media slice concrete: people can own portraits and documents.
-- Future source pages, albums and shrines receive dedicated reference tables
-- instead of a polymorphic reference that would weaken foreign-key integrity.
CREATE TABLE person_media (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  media_asset_id TEXT NOT NULL REFERENCES media_asset(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('portrait', 'document', 'other')),
  display_order INTEGER NOT NULL DEFAULT 0,
  caption TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE UNIQUE INDEX person_media_active_asset ON person_media(person_id, media_asset_id) WHERE retired_at IS NULL;
CREATE INDEX person_media_active_person ON person_media(person_id, display_order, id) WHERE retired_at IS NULL;
CREATE INDEX person_media_active_asset_lookup ON person_media(media_asset_id, person_id) WHERE retired_at IS NULL;
