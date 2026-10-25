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
  const prepared = lines.flatMap((line) => {
    if (/^INSERT INTO "d1_migrations" /.test(line)) { skippedMigrations += 1; return []; }
    const match = /^INSERT INTO "([a-z_]+)" /.exec(line);
    if (match && idempotentSeedTables.has(match[1])) { rewrittenSeeds += 1; return [line.replace(/^INSERT INTO /, "INSERT OR IGNORE INTO ")]; }
    return [line];
  });
  if (skippedMigrations === 0) throw new Error("Input does not contain D1 migration rows; expected a Wrangler data-only export.");
  await writeFile(output, `-- Prepared for an already-migrated D1 target.\n-- Removed ${skippedMigrations} internal d1_migrations rows; made ${rewrittenSeeds} seed rows idempotent.\n${prepared.join("\n")}`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ ok: true, skippedMigrations, rewrittenSeeds, output }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
