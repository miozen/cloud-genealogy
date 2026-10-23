#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
state_dir=".wrangler/local-core-model"
export XDG_CONFIG_HOME="$state_dir/config"
export WRANGLER_SEND_METRICS=false

npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  PRAGMA foreign_keys = ON;
  DELETE FROM branch_membership_snapshot;
  DELETE FROM branch;
  DELETE FROM lineage_succession_snapshot;
  DELETE FROM canonical_relation_snapshot;
  DELETE FROM lineage_revision;
  DELETE FROM lineage;
  DELETE FROM source_person_link;
  DELETE FROM source_relation_claim;
  DELETE FROM source_fact_claim;
  DELETE FROM source_person_record;
  DELETE FROM genealogy_edition;
  DELETE FROM genealogy;
  DELETE FROM person_name;
  DELETE FROM person;
  INSERT INTO person (id, display_name, visibility, created_at, updated_at) VALUES
    ('p-a', '同名', 'MEMBER', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    ('p-b', '同名', 'MEMBER', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    ('p-c', '子', 'MEMBER', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  INSERT INTO genealogy (id, title, created_at) VALUES ('g-1', '旧谱', '2026-01-01T00:00:00Z');
  INSERT INTO genealogy_edition (id, genealogy_id, title, created_at) VALUES ('e-1', 'g-1', '初版', '2026-01-01T00:00:00Z');
  INSERT INTO source_person_record (id, edition_id, source_key, name_text, raw_text, created_at) VALUES
    ('sr-1', 'e-1', '1', '同名', '原文甲', '2026-01-01T00:00:00Z'),
    ('sr-2', 'e-1', '2', '同名', '原文乙', '2026-01-01T00:00:00Z');
  INSERT INTO source_relation_claim (id, edition_id, subject_record_id, related_record_id, relation_kind, raw_text, created_at)
    VALUES ('sc-1', 'e-1', 'sr-1', 'sr-2', 'parent_child', '原谱记载', '2026-01-01T00:00:00Z');
  INSERT INTO source_person_link (id, source_record_id, person_id, status, created_at) VALUES
    ('sl-1', 'sr-1', 'p-a', 'confirmed', '2026-01-01T00:00:00Z');
  INSERT INTO lineage (id, name, created_at) VALUES ('l-1', '统一世系', '2026-01-01T00:00:00Z');
  INSERT INTO lineage_revision (id, lineage_id, state, created_at) VALUES ('r-1', 'l-1', 'published', '2026-01-01T00:00:00Z');
  INSERT INTO canonical_relation_snapshot (id, revision_id, subject_person_id, related_person_id, relation_kind, created_at)
    VALUES ('cr-bio', 'r-1', 'p-c', 'p-a', 'biological_parent', '2026-01-01T00:00:00Z'),
           ('cr-successor', 'r-1', 'p-c', 'p-b', 'successor_parent', '2026-01-01T00:00:00Z');
  INSERT INTO lineage_succession_snapshot (id, revision_id, parent_person_id, child_person_id, order_key, created_at)
    VALUES ('ss-1', 'r-1', 'p-b', 'p-c', '001', '2026-01-01T00:00:00Z');
  INSERT INTO branch (id, lineage_id, name, branch_kind, created_at) VALUES
    ('b-1', 'l-1', '长房', 'agnatic', '2026-01-01T00:00:00Z'),
    ('b-2', 'l-1', '迁居支', 'migration', '2026-01-01T00:00:00Z');
  INSERT INTO branch_membership_snapshot (id, revision_id, branch_id, person_id, membership_kind, created_at) VALUES
    ('bm-1', 'r-1', 'b-1', 'p-c', 'blood_primary', '2026-01-01T00:00:00Z'),
    ('bm-2', 'r-1', 'b-2', 'p-c', 'migration', '2026-01-01T00:00:00Z');
  SELECT (SELECT COUNT(*) FROM person WHERE display_name = '同名') AS duplicate_names,
         (SELECT COUNT(*) FROM canonical_relation_snapshot WHERE subject_person_id = 'p-c') AS preserved_parent_relations,
         (SELECT COUNT(*) FROM source_relation_claim) AS source_claims,
         (SELECT COUNT(*) FROM lineage_succession_snapshot) AS succession_edges,
         (SELECT COUNT(*) FROM branch_membership_snapshot WHERE person_id = 'p-c') AS memberships;
" > "$state_dir/result.json"

rg -q '"duplicate_names":\s*2' "$state_dir/result.json"
rg -q '"preserved_parent_relations":\s*2' "$state_dir/result.json"
rg -q '"source_claims":\s*1' "$state_dir/result.json"
rg -q '"succession_edges":\s*1' "$state_dir/result.json"
rg -q '"memberships":\s*2' "$state_dir/result.json"

if npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  INSERT INTO lineage_succession_snapshot (id, revision_id, parent_person_id, child_person_id, order_key, created_at)
  VALUES ('ss-duplicate-parent', 'r-1', 'p-a', 'p-c', '002', '2026-01-01T00:00:00Z');
" >/dev/null 2>&1; then
  echo "重复承谱上行边未被拒绝。" >&2
  exit 1
fi

if npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  INSERT INTO branch_membership_snapshot (id, revision_id, branch_id, person_id, membership_kind, created_at)
  VALUES ('bm-duplicate-blood', 'r-1', 'b-2', 'p-c', 'blood_primary', '2026-01-01T00:00:00Z');
" >/dev/null 2>&1; then
  echo "重复血缘主房未被拒绝。" >&2
  exit 1
fi

echo "本地核心族谱模型验证通过。"
