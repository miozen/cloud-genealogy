#!/usr/bin/env node
/* global console, process */
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";

function usage() { console.error("Usage: remote-backup-command-plan.mjs --preflight <preflight.json> --output <new-plan.json>"); }
function args(argv) { if (argv.length !== 4 || argv[0] !== "--preflight" || argv[2] !== "--output") throw new Error("Expected --preflight and --output."); return { preflight: path.resolve(argv[1]), output: path.resolve(argv[3]) }; }
async function absent(file) { try { await lstat(file); throw new Error("Refusing to overwrite command plan."); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; } }
try {
  const input = args(process.argv.slice(2)); await absent(input.output);
  const preflight = JSON.parse(await readFile(input.preflight, "utf8"));
  if (preflight?.formatVersion !== 1 || preflight?.operation !== "remote_backup_preflight" || preflight?.environment !== "preview" || preflight?.remoteExecutionAvailable !== false || typeof preflight.databaseName !== "string" || typeof preflight.r2Bucket !== "string" || !Array.isArray(preflight.confirmedBy) || preflight.confirmedBy.length !== 2) throw new Error("Preflight result is not an approved preview-only local plan.");
  const plan = { formatVersion: 1, operation: "remote_backup_command_plan", remoteExecutionAvailable: false, environment: "preview", backupId: preflight.backupId, approvalRecordId: preflight.approvalRecordId, requiredCapabilities: ["D1 Read scoped to configured preview database", "R2 S3 Object Read scoped to configured preview bucket"], prohibitedCapabilities: ["D1 Edit", "R2 write/delete", "Worker deployment", "Secrets access", "production access"], steps: ["Confirm active write freeze and one-time remote authorization.", "Export preview D1 to a restricted local temporary directory.", "Download only media objects referenced by the export manifest.", "Verify counts and SHA-256, then create encrypted local archive and register recovery point."] };
  await writeFile(input.output, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, remoteExecutionAvailable: false }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); usage(); process.exitCode = 1; }
