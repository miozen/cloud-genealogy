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
    (SELECT COUNT(*) FROM audit_log) AS audit_log
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
  await writeFile(path.resolve(values.get("output")), `${JSON.stringify({ formatVersion: 1, collectedAt: new Date().toISOString(), source: "local_d1", counts }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, counts }, null, 2));
} catch (error) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr) console.error(error.stderr);
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
