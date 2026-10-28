#!/usr/bin/env node
/* global console, process */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error("Usage: prepare-d1-restore-data.mjs --input <data-only.sql> --output <new.sql>");
}

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    if (values.has(key)) throw new Error(`Duplicate ${key}.`);
    values.set(key, value);
  }
  if (values.size !== 2 || !values.get("--input") || !values.get("--output")) throw new Error("Exactly --input and --output are required.");
  return { input: path.resolve(values.get("--input")), output: path.resolve(values.get("--output")) };
}

const idempotentSeedTables = new Set(["role", "permission", "role_permission"]);

try {
  const { input, output } = args(process.argv.slice(2));
  const source = await readFile(input, "utf8");
  const lines = source.split(/\r?\n/);
  let skippedMigrations = 0, rewrittenSeeds = 0;
  const epochRows = [];
  const prepared = lines.flatMap((line) => {
    if (/^INSERT INTO "d1_migrations" /.test(line)) { skippedMigrations += 1; return []; }
    // This singleton is seeded by migration 0020 but its value changes when a
    // freeze starts. Preserve the backed-up epoch, not the target seed (1).
    if (/^INSERT INTO "backup_write_epoch" /.test(line)) { epochRows.push(line.replace(/^INSERT INTO /, "INSERT OR REPLACE INTO ")); return []; }
    const match = /^INSERT INTO "([a-z_]+)" /.exec(line);
    if (match && idempotentSeedTables.has(match[1])) { rewrittenSeeds += 1; return [line.replace(/^INSERT INTO /, "INSERT OR IGNORE INTO ")]; }
    return [line];
  });
  if (skippedMigrations === 0) throw new Error("Input does not contain D1 migration rows; expected a Wrangler data-only export.");
  if (epochRows.length > 1) throw new Error("Backup contains duplicate epoch singleton rows.");
  if (source.includes("0020_backup_write_epoch.sql") && epochRows.length !== 1) throw new Error("Backup migration 0020 requires exactly one epoch singleton row.");
  // Restoring historical freeze rows runs the epoch trigger. Restore the saved
  // singleton last so those trigger executions do not alter the source epoch.
  await writeFile(output, `-- Prepared for an already-migrated D1 target.\n-- Removed ${skippedMigrations} internal d1_migrations rows; made ${rewrittenSeeds} seed rows idempotent; restored ${epochRows.length} epoch singleton rows.\n${prepared.join("\n")}\n${epochRows.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ ok: true, skippedMigrations, rewrittenSeeds, rewrittenEpoch: epochRows.length, output }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
