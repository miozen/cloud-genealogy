#!/usr/bin/env bash
set -euo pipefail

# This is a disposable local-only recovery drill. It never uses --remote,
# preview, production, credentials, or normal Wrangler local state.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
fixture_root="$(mktemp -d)"
target_state="$fixture_root/target-state"
package_dir="$fixture_root/backup-package"
prepared_state="$fixture_root/prepared-target-state"
archive_file="$fixture_root/backup-package.tar.gz"
encrypted_file="$fixture_root/backup-package.tar.gz.cgbk"
decrypted_file="$fixture_root/backup-package-restored.tar.gz"
decrypted_dir="$fixture_root/decrypted"
source_media="$fixture_root/source-media.txt"
restored_media="$fixture_root/restored-media.txt"
passphrase_file="$fixture_root/recovery-passphrase"
wrong_passphrase_file="$fixture_root/wrong-recovery-passphrase"
export XDG_CONFIG_HOME="$fixture_root/config"
export WRANGLER_SEND_METRICS=false

cleanup() {
  if [[ "${KEEP_LOCAL_BACKUP_FIXTURE:-}" == "1" ]]; then
    echo "本地备份演练夹具保留于：$fixture_root"
  else
    rm -rf "$fixture_root"
  fi
}
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

(
  cd "$fixture_root"
  "$project_root/node_modules/.bin/wrangler" d1 export DB --local --no-schema --output "$fixture_root/data-only.sql" >/dev/null
)
printf 'INSERT INTO "person" VALUES (\x27not-a-wrangler-export\x27);\n' > "$fixture_root/invalid-data.sql"
if node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/invalid-data.sql" --output "$fixture_root/invalid-prepared.sql" >/dev/null 2>&1; then
  echo "非 Wrangler data-only 文件通过了恢复数据准备。" >&2
  exit 1
fi
test ! -e "$fixture_root/invalid-prepared.sql"
node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/data-only.sql" --output "$fixture_root/prepared-data.sql" >/dev/null
if node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/data-only.sql" --output "$fixture_root/prepared-data.sql" >/dev/null 2>&1; then
  echo "恢复数据准备覆盖了已有输出文件。" >&2
  exit 1
fi
! rg -q 'INSERT INTO "d1_migrations"' "$fixture_root/prepared-data.sql"
rg -q '^INSERT OR IGNORE INTO "role"' "$fixture_root/prepared-data.sql"
npx wrangler d1 migrations apply DB --local --persist-to "$prepared_state" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$prepared_state" --file "$fixture_root/prepared-data.sql" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$prepared_state" --command "SELECT COUNT(*) AS people FROM person WHERE id = 'backup-fixture-person';" > "$fixture_root/prepared-result.json"
rg -q '"people":\s*1' "$fixture_root/prepared-result.json"

printf 'disposable-local-recovery-passphrase\n' > "$passphrase_file"
chmod 600 "$passphrase_file"
tar --create --gzip --file "$archive_file" --directory "$fixture_root" backup-package
node "$project_root/scripts/backup-crypt.mjs" encrypt --input "$archive_file" --output "$encrypted_file" --passphrase-file "$passphrase_file" >/dev/null
node "$project_root/scripts/backup-crypt.mjs" decrypt --input "$encrypted_file" --output "$decrypted_file" --passphrase-file "$passphrase_file" >/dev/null
cmp -- "$archive_file" "$decrypted_file"
mkdir -p "$decrypted_dir"
tar --extract --gzip --file "$decrypted_file" --directory "$decrypted_dir"
node "$project_root/scripts/backup-package.mjs" verify --package "$decrypted_dir/backup-package" --migration-dir "$project_root/migrations" >/dev/null

printf 'different-disposable-recovery-passphrase\n' > "$wrong_passphrase_file"
chmod 600 "$wrong_passphrase_file"
if node "$project_root/scripts/backup-crypt.mjs" decrypt --input "$encrypted_file" --output "$fixture_root/wrong-passphrase.tar.gz" --passphrase-file "$wrong_passphrase_file" >/dev/null 2>&1; then
  echo "错误口令通过了解密认证。" >&2
  exit 1
fi
test ! -e "$fixture_root/wrong-passphrase.tar.gz"

npx wrangler d1 execute DB --local --persist-to "$target_state" --file "$package_dir/d1/schema-and-data.sql" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$target_state" --command "
  SELECT COUNT(*) AS people FROM person WHERE id = 'backup-fixture-person';
" > "$fixture_root/restore-result.json"
rg -q '"people":\s*1' "$fixture_root/restore-result.json"

npx wrangler r2 object put cloud-genealogy-local/media/fixture.txt --local --persist-to "$target_state" --file "$package_dir/r2/media/fixture.txt" >/dev/null
npx wrangler r2 object get cloud-genealogy-local/media/fixture.txt --local --persist-to "$target_state" --file "$restored_media"
cmp -- "$source_media" "$restored_media"

# A changed payload must fail before any target restore command is allowed.
tampered_package_dir="$fixture_root/tampered-backup-package"
cp -R "$package_dir" "$tampered_package_dir"
printf 'tampered\n' >> "$tampered_package_dir/r2/media/fixture.txt"
if node scripts/backup-package.mjs verify --package "$tampered_package_dir" --migration-dir "$project_root/migrations" >/dev/null 2>&1; then
  echo "被篡改的备份包通过了预检。" >&2
  exit 1
fi

printf '\001' | dd of="$encrypted_file" bs=1 seek=24 conv=notrunc status=none
if node "$project_root/scripts/backup-crypt.mjs" decrypt --input "$encrypted_file" --output "$fixture_root/tampered.tar.gz" --passphrase-file "$passphrase_file" >/dev/null 2>&1; then
  echo "被篡改的加密备份包通过了解密认证。" >&2
  exit 1
fi
test ! -e "$fixture_root/tampered.tar.gz"

echo "本地 D1/R2 备份包预检、加密认证与隔离恢复演练通过。"
