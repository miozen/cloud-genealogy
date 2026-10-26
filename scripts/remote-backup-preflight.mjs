#!/usr/bin/env node
/* global console, process */
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error("Usage: remote-backup-preflight.mjs --plan <non-secret-plan.json> --wrangler-config <wrangler.jsonc> --output <new-result.json>");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    values.set(key, value);
  }
  if (values.size !== 3 || !values.get("--plan") || !values.get("--wrangler-config") || !values.get("--output")) throw new Error("Expected exactly --plan, --wrangler-config and --output.");
  return { plan: path.resolve(values.get("--plan")), wranglerConfig: path.resolve(values.get("--wrangler-config")), output: path.resolve(values.get("--output")) };
}

async function outputMustNotExist(file) {
  try { await lstat(file); throw new Error("Refusing to overwrite preflight output."); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; }
}

function containsSecret(value, trail = "") {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    const location = trail ? `${trail}.${key}` : key;
    if (/(token|secret|password|credential|access_?key)/iu.test(key)) throw new Error(`Plan must not contain secrets: ${location}`);
    containsSecret(child, location);
  }
  return false;
}

function oneBinding(bindings, binding, kind) {
  const matches = (bindings ?? []).filter((item) => item?.binding === binding);
  if (matches.length !== 1) throw new Error(`Wrangler preview config must define exactly one ${kind} ${binding} binding.`);
  return matches[0];
}

function validatePlan(plan, config) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Plan must be an object.");
  containsSecret(plan);
  if (plan.formatVersion !== 1 || plan.operation !== "remote_backup") throw new Error("Unsupported remote backup plan format.");
  if (plan.environment !== "preview") throw new Error("Only the explicitly approved preview environment can pass preflight.");
  for (const name of ["backupId", "approvalRecordId", "offsiteStorageLocationId"]) if (typeof plan[name] !== "string" || plan[name].trim().length === 0 || plan[name].length > 255) throw new Error(`Invalid ${name}.`);
  if (typeof plan.createdAt !== "string" || Number.isNaN(Date.parse(plan.createdAt))) throw new Error("Invalid createdAt.");
  if (typeof plan.writeFreezeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(plan.writeFreezeId)) throw new Error("writeFreezeId must be a UUID.");
  if (!Array.isArray(plan.confirmedBy) || plan.confirmedBy.length !== 2 || !plan.confirmedBy.every((value) => typeof value === "string" && value.trim().length >= 3 && value.length <= 255) || new Set(plan.confirmedBy).size !== 2) throw new Error("Plan requires exactly two distinct non-secret confirmer identifiers.");
  const preview = config?.env?.preview;
  if (!preview || typeof preview !== "object") throw new Error("Wrangler config has no preview environment.");
  const database = oneBinding(preview.d1_databases, "DB", "D1");
  const bucket = oneBinding(preview.r2_buckets, "MEDIA", "R2");
  if (plan.databaseName !== database.database_name || plan.databaseId !== database.database_id || plan.r2Bucket !== bucket.bucket_name) throw new Error("Plan target does not exactly match configured preview D1/R2 bindings.");
  return { backupId: plan.backupId, approvalRecordId: plan.approvalRecordId, environment: plan.environment, databaseName: plan.databaseName, databaseId: plan.databaseId, r2Bucket: plan.r2Bucket, writeFreezeId: plan.writeFreezeId, confirmedBy: plan.confirmedBy, offsiteStorageLocationId: plan.offsiteStorageLocationId };
}

try {
  const args = parseArgs(process.argv.slice(2));
  await outputMustNotExist(args.output);
  const plan = JSON.parse(await readFile(args.plan, "utf8"));
  const config = JSON.parse(await readFile(args.wranglerConfig, "utf8"));
  const checked = validatePlan(plan, config);
  const result = { formatVersion: 1, operation: "remote_backup_preflight", checkedAt: new Date().toISOString(), remoteExecutionAvailable: false, ...checked };
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, environment: result.environment, remoteExecutionAvailable: false }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
