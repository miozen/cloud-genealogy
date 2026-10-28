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
encrypted_file="$fixture_root/backup-package.tar.gz.cgbk"
decrypted_file="$fixture_root/backup-package-restored.tar.gz"
decrypted_dir="$fixture_root/decrypted"
source_media="$fixture_root/source-media.txt"
restored_media="$fixture_root/restored-media.txt"
source_retired_media="$fixture_root/source-retired-media.txt"
restored_retired_media="$fixture_root/restored-retired-media.txt"
passphrase_file="$fixture_root/recovery-passphrase"
wrong_passphrase_file="$fixture_root/wrong-recovery-passphrase"
catalog_file="$fixture_root/recovery-catalog.json"
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
printf 'local retired backup media fixture\n' > "$source_retired_media"
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
  INSERT INTO account (id, username, display_name, password_scheme, password_hash, status, created_at, updated_at)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'backup.fixture', '备份演练操作人', 'fixture', 'fixture', 'active', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z');
  INSERT INTO backup_write_freeze (id, reason, created_by_account_id, created_at, released_by_account_id, released_at, release_reason)
  VALUES ('historical-freeze-1', 'fixture', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:00:00Z', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:01:00Z', 'fixture');
  INSERT INTO backup_write_freeze (id, reason, created_by_account_id, created_at, released_by_account_id, released_at, release_reason)
  VALUES ('historical-freeze-2', 'fixture', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:02:00Z', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:03:00Z', 'fixture');
  UPDATE backup_write_epoch SET epoch = 7 WHERE id = 1;
  INSERT INTO backup_write_admission (id, admitted_at, completed_at, epoch) VALUES ('historical-admission', '2026-10-25T00:00:00Z', '2026-10-25T00:01:00Z', 6);
  INSERT INTO person (id, display_name, visibility, created_at, updated_at)
  VALUES ('backup-fixture-person', '备份演练人物', 'MEMBER', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z');
  INSERT INTO media_asset (id, object_key, sha256, byte_size, mime_type, original_filename, visibility, state, created_by_account_id, created_at, upload_expires_at, finalized_at)
  VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'media/fixture.txt', 'ebfad43a2975422358db27951444e12ca0465dca77cfc2725ae272eab13e2b30', 27, 'image/jpeg', 'fixture.jpg', 'MEMBER', 'active', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:00:00Z', '2026-10-25T00:05:00Z', '2026-10-25T00:00:00Z');
  INSERT INTO person_media (id, person_id, media_asset_id, role, display_order, created_by_account_id, created_at)
  VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'backup-fixture-person', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'document', 3, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:00:00Z');
  INSERT INTO media_asset (id, object_key, sha256, byte_size, mime_type, original_filename, visibility, state, created_by_account_id, created_at, upload_expires_at, finalized_at, retired_at, cleanup_after)
  VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'media/retired-fixture.txt', 'ba9a49a050dc9257983495b421ccea278964776d5aba10b1654b7f3052ce91c6', 35, 'image/jpeg', 'retired-fixture.jpg', 'MEMBER', 'retired', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:00:00Z', '2026-10-25T00:05:00Z', '2026-10-25T00:00:00Z', '2026-10-25T00:10:00Z', '2026-11-24T00:10:00Z');
  INSERT INTO person_media (id, person_id, media_asset_id, role, display_order, created_by_account_id, created_at, retired_at)
  VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'backup-fixture-person', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'document', 4, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-25T00:00:00Z', '2026-10-25T00:10:00Z');
" >/dev/null
  "$project_root/node_modules/.bin/wrangler" d1 export DB --local --output "$package_dir/d1/schema-and-data.sql" >/dev/null

  "$project_root/node_modules/.bin/wrangler" r2 object put cloud-genealogy-local/media/fixture.txt --local --file "$source_media" >/dev/null
  "$project_root/node_modules/.bin/wrangler" r2 object get cloud-genealogy-local/media/fixture.txt --local --file "$package_dir/r2/media/fixture.txt" >/dev/null
  "$project_root/node_modules/.bin/wrangler" r2 object put cloud-genealogy-local/media/retired-fixture.txt --local --file "$source_retired_media" >/dev/null
  "$project_root/node_modules/.bin/wrangler" r2 object get cloud-genealogy-local/media/retired-fixture.txt --local --file "$package_dir/r2/media/retired-fixture.txt" >/dev/null
)

node "$project_root/scripts/backup-counts.mjs" \
  --wrangler "$project_root/node_modules/.bin/wrangler" \
  --cwd "$fixture_root" \
  --output "$fixture_root/counts.json" >/dev/null
rg -q '"person": 1' "$fixture_root/counts.json"
rg -q '"media_asset": 2' "$fixture_root/counts.json"
rg -q '"person_media": 2' "$fixture_root/counts.json"
rg -q '"mediaAssetId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"' "$fixture_root/counts.json"
rg -q '"mediaAssetId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"' "$fixture_root/counts.json"
rg -q '"state": "retired"' "$fixture_root/counts.json"
rg -q '"activeReferenceCount": 0' "$fixture_root/counts.json"

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
sed '/^INSERT INTO "backup_write_epoch" /d' "$fixture_root/data-only.sql" > "$fixture_root/missing-epoch.sql"
if node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/missing-epoch.sql" --output "$fixture_root/missing-epoch-prepared.sql" >/dev/null 2>&1; then
  echo "缺少写入代次的 0020 备份通过了恢复数据准备。" >&2
  exit 1
fi
test ! -e "$fixture_root/missing-epoch-prepared.sql"
cp "$fixture_root/data-only.sql" "$fixture_root/duplicate-epoch.sql"
printf '\n' >> "$fixture_root/duplicate-epoch.sql"
sed -n '/^INSERT INTO "backup_write_epoch" /p' "$fixture_root/data-only.sql" >> "$fixture_root/duplicate-epoch.sql"
if node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/duplicate-epoch.sql" --output "$fixture_root/duplicate-epoch-prepared.sql" >/dev/null 2>&1; then
  echo "重复写入代次的备份通过了恢复数据准备。" >&2
  exit 1
fi
test ! -e "$fixture_root/duplicate-epoch-prepared.sql"
node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/data-only.sql" --output "$fixture_root/prepared-data.sql" >/dev/null
if node "$project_root/scripts/prepare-d1-restore-data.mjs" --input "$fixture_root/data-only.sql" --output "$fixture_root/prepared-data.sql" >/dev/null 2>&1; then
  echo "恢复数据准备覆盖了已有输出文件。" >&2
  exit 1
fi
! rg -q 'INSERT INTO "d1_migrations"' "$fixture_root/prepared-data.sql"
rg -q '^INSERT OR IGNORE INTO "role"' "$fixture_root/prepared-data.sql"
rg -q '^INSERT OR REPLACE INTO "backup_write_epoch"' "$fixture_root/prepared-data.sql"
npx wrangler d1 migrations apply DB --local --persist-to "$prepared_state" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$prepared_state" --file "$fixture_root/prepared-data.sql" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$prepared_state" --command "SELECT (SELECT COUNT(*) FROM person WHERE id = 'backup-fixture-person') AS people, (SELECT epoch FROM backup_write_epoch WHERE id = 1) AS epoch, (SELECT epoch FROM backup_write_admission WHERE id = 'historical-admission') AS admission_epoch, (SELECT COUNT(*) FROM backup_write_freeze) AS freezes;" > "$fixture_root/prepared-result.json"
rg -q '"people":\s*1' "$fixture_root/prepared-result.json"
rg -q '"epoch":\s*7' "$fixture_root/prepared-result.json"
rg -q '"admission_epoch":\s*6' "$fixture_root/prepared-result.json"
rg -q '"freezes":\s*2' "$fixture_root/prepared-result.json"

printf 'disposable-local-recovery-passphrase\n' > "$passphrase_file"
chmod 600 "$passphrase_file"
node "$project_root/scripts/backup-local-archive.mjs" --package "$package_dir" --migration-dir "$project_root/migrations" --destination "$fixture_root" --backup-id backup-package --passphrase-file "$passphrase_file" >/dev/null
node "$project_root/scripts/backup-local-archive.mjs" --package "$package_dir" --migration-dir "$project_root/migrations" --destination "$fixture_root" --backup-id backup-package-2 --passphrase-file "$passphrase_file" >/dev/null
node "$project_root/scripts/backup-local-archive.mjs" --package "$package_dir" --migration-dir "$project_root/migrations" --destination "$fixture_root" --backup-id backup-package-3 --passphrase-file "$passphrase_file" >/dev/null
node "$project_root/scripts/backup-recovery-catalog.mjs" register --catalog "$catalog_file" --backup-id backup-package --archive "$encrypted_file" >/dev/null
node "$project_root/scripts/backup-recovery-catalog.mjs" register --catalog "$catalog_file" --backup-id backup-package-2 --archive "$fixture_root/backup-package-2.tar.gz.cgbk" >/dev/null
node "$project_root/scripts/backup-recovery-catalog.mjs" register --catalog "$catalog_file" --backup-id backup-package-3 --archive "$fixture_root/backup-package-3.tar.gz.cgbk" >/dev/null
node "$project_root/scripts/backup-recovery-catalog.mjs" verify-retention --catalog "$catalog_file" --minimum 3 >/dev/null
node "$project_root/scripts/backup-crypt.mjs" decrypt --input "$encrypted_file" --output "$decrypted_file" --passphrase-file "$passphrase_file" >/dev/null
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
  SELECT asset.state, asset.sha256, asset.byte_size, COUNT(link.id) AS active_links FROM media_asset AS asset LEFT JOIN person_media AS link ON link.media_asset_id = asset.id AND link.retired_at IS NULL WHERE asset.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' GROUP BY asset.id, asset.state, asset.sha256, asset.byte_size;
  SELECT asset.state, asset.sha256, asset.byte_size, asset.cleanup_after, COUNT(link.id) AS active_links, (SELECT COUNT(*) FROM person_media WHERE media_asset_id = asset.id AND retired_at IS NOT NULL) AS retired_links FROM media_asset AS asset LEFT JOIN person_media AS link ON link.media_asset_id = asset.id AND link.retired_at IS NULL WHERE asset.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' GROUP BY asset.id, asset.state, asset.sha256, asset.byte_size, asset.cleanup_after;
" > "$fixture_root/restore-result.json"
rg -q '"people":\s*1' "$fixture_root/restore-result.json"
rg -q '"state":\s*"active"' "$fixture_root/restore-result.json"
rg -q '"sha256":\s*"ebfad43a2975422358db27951444e12ca0465dca77cfc2725ae272eab13e2b30"' "$fixture_root/restore-result.json"
rg -q '"active_links":\s*1' "$fixture_root/restore-result.json"
rg -q '"state":\s*"retired"' "$fixture_root/restore-result.json"
rg -q '"sha256":\s*"ba9a49a050dc9257983495b421ccea278964776d5aba10b1654b7f3052ce91c6"' "$fixture_root/restore-result.json"
rg -q '"cleanup_after":\s*"2026-11-24T00:10:00Z"' "$fixture_root/restore-result.json"
rg -q '"active_links":\s*0' "$fixture_root/restore-result.json"
rg -q '"retired_links":\s*1' "$fixture_root/restore-result.json"

npx wrangler r2 object put cloud-genealogy-local/media/fixture.txt --local --persist-to "$target_state" --file "$package_dir/r2/media/fixture.txt" >/dev/null
npx wrangler r2 object get cloud-genealogy-local/media/fixture.txt --local --persist-to "$target_state" --file "$restored_media"
cmp -- "$source_media" "$restored_media"
npx wrangler r2 object put cloud-genealogy-local/media/retired-fixture.txt --local --persist-to "$target_state" --file "$package_dir/r2/media/retired-fixture.txt" >/dev/null
npx wrangler r2 object get cloud-genealogy-local/media/retired-fixture.txt --local --persist-to "$target_state" --file "$restored_retired_media"
cmp -- "$source_retired_media" "$restored_retired_media"

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
