PRAGMA foreign_keys = ON;

-- Identity details are separate from the stable person anchor created in 0003.
CREATE TABLE person_name (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  name_text TEXT NOT NULL,
  name_kind TEXT NOT NULL CHECK (name_kind IN ('genealogy', 'courtesy', 'art_name', 'alias', 'source_text')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  visibility TEXT NOT NULL DEFAULT 'MEMBER' CHECK (visibility IN ('PUBLIC', 'MEMBER', 'ADMIN')),
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE UNIQUE INDEX person_name_one_primary_active ON person_name(person_id) WHERE is_primary = 1 AND retired_at IS NULL;
CREATE INDEX person_name_lookup ON person_name(name_text, person_id) WHERE retired_at IS NULL;

CREATE TABLE place (
  id TEXT PRIMARY KEY,
  name_text TEXT NOT NULL,
  parent_place_id TEXT REFERENCES place(id) ON DELETE RESTRICT,
  place_kind TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE person_fact (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  fact_kind TEXT NOT NULL,
  value_text TEXT,
  date_text TEXT,
  date_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (date_precision IN ('exact', 'year_month', 'year', 'approximate', 'unknown')),
  place_id TEXT REFERENCES place(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL DEFAULT 'MEMBER' CHECK (visibility IN ('PUBLIC', 'MEMBER', 'ADMIN')),
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE INDEX person_fact_active ON person_fact(person_id, fact_kind) WHERE retired_at IS NULL;

-- Source tables retain transcription claims even when no unified person exists.
CREATE TABLE genealogy (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE genealogy_edition (
  id TEXT PRIMARY KEY,
  genealogy_id TEXT NOT NULL REFERENCES genealogy(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  edition_label TEXT,
  supersedes_edition_id TEXT REFERENCES genealogy_edition(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE source_person_record (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES genealogy_edition(id) ON DELETE RESTRICT,
  source_key TEXT,
  name_text TEXT,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes_record_id TEXT REFERENCES source_person_record(id) ON DELETE RESTRICT,
  UNIQUE (edition_id, source_key)
);
CREATE TABLE source_fact_claim (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES genealogy_edition(id) ON DELETE RESTRICT,
  subject_record_id TEXT REFERENCES source_person_record(id) ON DELETE RESTRICT,
  fact_kind TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes_claim_id TEXT REFERENCES source_fact_claim(id) ON DELETE RESTRICT
);
CREATE TABLE source_relation_claim (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES genealogy_edition(id) ON DELETE RESTRICT,
  subject_record_id TEXT REFERENCES source_person_record(id) ON DELETE RESTRICT,
  related_record_id TEXT REFERENCES source_person_record(id) ON DELETE RESTRICT,
  relation_kind TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes_claim_id TEXT REFERENCES source_relation_claim(id) ON DELETE RESTRICT
);
CREATE TABLE source_person_link (
  id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL REFERENCES source_person_record(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected', 'revoked')),
  linked_by_account_id TEXT REFERENCES account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX source_person_link_active ON source_person_link(source_record_id) WHERE status = 'confirmed' AND revoked_at IS NULL;
CREATE INDEX source_person_link_person ON source_person_link(person_id, status);
CREATE INDEX source_claim_subject ON source_fact_claim(edition_id, subject_record_id);
CREATE INDEX source_relation_subject ON source_relation_claim(edition_id, subject_record_id);

-- Unified lineage snapshots only point to evidence; they never update source claims.
CREATE TABLE lineage (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  succession_rule TEXT NOT NULL DEFAULT 'configured',
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE lineage_revision (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL REFERENCES lineage(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'superseded')),
  based_on_revision_id TEXT REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  published_at TEXT
);
CREATE UNIQUE INDEX lineage_one_published_revision ON lineage_revision(lineage_id) WHERE state = 'published';
CREATE TABLE canonical_relation_snapshot (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  subject_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  related_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('biological_parent', 'adoptive_parent', 'successor_parent', 'spouse')),
  created_at TEXT NOT NULL,
  CHECK (subject_person_id <> related_person_id)
);
CREATE TABLE lineage_succession_snapshot (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  parent_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  child_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  order_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (parent_person_id <> child_person_id),
  UNIQUE (revision_id, parent_person_id, order_key)
);
CREATE UNIQUE INDEX succession_one_parent_per_child ON lineage_succession_snapshot(revision_id, child_person_id);
CREATE INDEX succession_children_order ON lineage_succession_snapshot(revision_id, parent_person_id, order_key);

CREATE TABLE branch (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL REFERENCES lineage(id) ON DELETE RESTRICT,
  parent_branch_id TEXT REFERENCES branch(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  branch_kind TEXT NOT NULL CHECK (branch_kind IN ('agnatic', 'migration', 'administrative')),
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE branch_membership_snapshot (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES lineage_revision(id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  membership_kind TEXT NOT NULL CHECK (membership_kind IN ('blood_primary', 'migration', 'administrative')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX branch_one_blood_primary ON branch_membership_snapshot(revision_id, person_id) WHERE membership_kind = 'blood_primary';
CREATE INDEX branch_membership_lookup ON branch_membership_snapshot(branch_id, membership_kind, person_id);
