#!/usr/bin/env node
/* global console, process */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const countQuery = `
  SELECT
    (SELECT COUNT(*) FROM account) AS account,
    (SELECT COUNT(*) FROM account_role) AS account_role,
    (SELECT COUNT(*) FROM account_scope) AS account_scope,
    (SELECT COUNT(*) FROM person) AS person,
    (SELECT COUNT(*) FROM genealogy) AS genealogy,
    (SELECT COUNT(*) FROM genealogy_edition) AS genealogy_edition,
    (SELECT COUNT(*) FROM source_person_record) AS source_person_record,
    (SELECT COUNT(*) FROM source_fact_claim) AS source_fact_claim,
    (SELECT COUNT(*) FROM source_relation_claim) AS source_relation_claim,
    (SELECT COUNT(*) FROM lineage) AS lineage,
    (SELECT COUNT(*) FROM lineage_revision) AS lineage_revision,
    (SELECT COUNT(*) FROM lineage_succession_snapshot) AS lineage_succession_snapshot,
    (SELECT COUNT(*) FROM canonical_relation_snapshot) AS canonical_relation_snapshot,
    (SELECT COUNT(*) FROM branch) AS branch,
    (SELECT COUNT(*) FROM branch_membership_snapshot) AS branch_membership_snapshot,
    (SELECT COUNT(*) FROM media_asset) AS media_asset,
    (SELECT COUNT(*) FROM person_media) AS person_media,
    (SELECT COUNT(*) FROM audit_log) AS audit_log
`;
const mediaInventoryQuery = `
  SELECT asset.id AS media_asset_id, asset.object_key, asset.sha256, asset.byte_size, asset.mime_type, asset.state,
    COUNT(link.id) AS active_reference_count
  FROM media_asset AS asset
  LEFT JOIN person_media AS link ON link.media_asset_id = asset.id AND link.retired_at IS NULL
  WHERE asset.state IN ('active', 'retired')
  GROUP BY asset.id, asset.object_key, asset.sha256, asset.byte_size, asset.mime_type, asset.state
  ORDER BY asset.object_key, asset.id
`;

function usage() {
  console.error("Usage: backup-counts.mjs --wrangler <absolute-path> --cwd <local-project-dir> --output <counts.json>");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    values.set(key.slice(2), value);
  }
  for (const name of ["wrangler", "cwd", "output"]) if (!values.get(name)) throw new Error(`Missing --${name}.`);
  if (values.size !== 3) throw new Error("Only --wrangler, --cwd and --output are accepted; this command is local-only.");
  return values;
}

try {
  const values = parseArgs(process.argv.slice(2));
  const raw = execFileSync(values.get("wrangler"), ["d1", "execute", "DB", "--local", "--command", countQuery, "--json"], {
    cwd: path.resolve(values.get("cwd")), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  const payload = JSON.parse(raw);
  const rows = payload?.[0]?.results;
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") throw new Error("Local D1 count query did not return one result row.");
  const counts = {};
  for (const [name, value] of Object.entries(rows[0])) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Local D1 count query returned an invalid value for ${name}.`);
    counts[name] = value;
  }
  const rawMedia = execFileSync(values.get("wrangler"), ["d1", "execute", "DB", "--local", "--command", mediaInventoryQuery, "--json"], {
    cwd: path.resolve(values.get("cwd")), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  const mediaPayload = JSON.parse(rawMedia);
  const mediaRows = mediaPayload?.[0]?.results;
  if (!Array.isArray(mediaRows)) throw new Error("Local D1 media inventory query did not return rows.");
  const mediaAssets = mediaRows.map((row) => {
    if (!row || typeof row !== "object" || typeof row.media_asset_id !== "string" || typeof row.object_key !== "string" || typeof row.sha256 !== "string" || !Number.isSafeInteger(row.byte_size) || typeof row.mime_type !== "string" || typeof row.state !== "string" || !Number.isSafeInteger(row.active_reference_count)) throw new Error("Local D1 media inventory contains an invalid row.");
    return { mediaAssetId: row.media_asset_id, objectKey: row.object_key, sha256: row.sha256, byteSize: row.byte_size, mimeType: row.mime_type, state: row.state, activeReferenceCount: row.active_reference_count };
  });
  await writeFile(path.resolve(values.get("output")), `${JSON.stringify({ formatVersion: 2, collectedAt: new Date().toISOString(), source: "local_d1", counts, mediaAssets }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, counts, mediaAssets }, null, 2));
} catch (error) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr) console.error(error.stderr);
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
