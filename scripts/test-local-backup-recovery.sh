#!/usr/bin/env bash
set -euo pipefail

# This is a disposable local-only recovery drill. It never uses --remote,
# preview, production, credentials, or normal Wrangler local state.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
fixture_root="$(mktemp -d)"
target_state="$fixture_root/target-state"
package_dir="$fixture_root/backup-package"
source_media="$fixture_root/source-media.txt"
restored_media="$fixture_root/restored-media.txt"
export XDG_CONFIG_HOME="$fixture_root/config"
export WRANGLER_SEND_METRICS=false

cleanup() { rm -rf "$fixture_root"; }
trap cleanup EXIT

mkdir -p "$package_dir/d1" "$package_dir/r2/media"
printf 'local backup media fixture\n' > "$source_media"
cp -R "$project_root/migrations" "$fixture_root/migrations"
printf '%s\n' \
  '{' \
  '  "name": "cloud-genealogy-local-backup-fixture",' \
  '  "compatibility_date": "2026-10-22",' \
  '  "d1_databases": [{"binding": "DB", "database_name": "cloud-genealogy-local", "database_id": "00000000-0000-0000-0000-000000000000"}],' \
  '  "r2_buckets": [{"binding": "MEDIA", "bucket_name": "cloud-genealogy-local"}]' \
  '}' > "$fixture_root/wrangler.jsonc"

(
  cd "$fixture_root"
  "$project_root/node_modules/.bin/wrangler" d1 migrations apply DB --local >/dev/null
  "$project_root/node_modules/.bin/wrangler" d1 execute DB --local --command "
  INSERT INTO person (id, display_name, visibility, created_at, updated_at)
  VALUES ('backup-fixture-person', '备份演练人物', 'MEMBER', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z');
" >/dev/null
  "$project_root/node_modules/.bin/wrangler" d1 export DB --local --output "$package_dir/d1/schema-and-data.sql" >/dev/null

  "$project_root/node_modules/.bin/wrangler" r2 object put cloud-genealogy-local/media/fixture.txt --local --file "$source_media" >/dev/null
  "$project_root/node_modules/.bin/wrangler" r2 object get cloud-genealogy-local/media/fixture.txt --local --file "$package_dir/r2/media/fixture.txt" >/dev/null
)

node "$project_root/scripts/backup-counts.mjs" \
  --wrangler "$project_root/node_modules/.bin/wrangler" \
  --cwd "$fixture_root" \
  --output "$fixture_root/counts.json" >/dev/null
rg -q '"person": 1' "$fixture_root/counts.json"

node scripts/backup-package.mjs create \
  --package "$package_dir" \
  --migration-dir "$project_root/migrations" \
  --source-environment local \
  --git-commit 0000000 \
  --counts-file "$fixture_root/counts.json" >/dev/null
node scripts/backup-package.mjs verify --package "$package_dir" --migration-dir "$project_root/migrations" >/dev/null

npx wrangler d1 execute DB --local --persist-to "$target_state" --file "$package_dir/d1/schema-and-data.sql" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$target_state" --command "
  SELECT COUNT(*) AS people FROM person WHERE id = 'backup-fixture-person';
" > "$fixture_root/restore-result.json"
rg -q '"people":\s*1' "$fixture_root/restore-result.json"

npx wrangler r2 object put cloud-genealogy-local/media/fixture.txt --local --persist-to "$target_state" --file "$package_dir/r2/media/fixture.txt" >/dev/null
npx wrangler r2 object get cloud-genealogy-local/media/fixture.txt --local --persist-to "$target_state" --file "$restored_media" >/dev/null
cmp -- "$source_media" "$restored_media"

# A changed payload must fail before any target restore command is allowed.
printf 'tampered\n' >> "$package_dir/r2/media/fixture.txt"
if node scripts/backup-package.mjs verify --package "$package_dir" --migration-dir "$project_root/migrations" >/dev/null 2>&1; then
  echo "被篡改的备份包通过了预检。" >&2
  exit 1
fi

echo "本地 D1/R2 备份包预检与隔离恢复演练通过。"
