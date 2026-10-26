#!/usr/bin/env node
/* global console, process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/remote-backup-preflight.mjs");
const commandPlan = path.join(root, "scripts/remote-backup-command-plan.mjs");
const executionPrecheck = path.join(root, "scripts/remote-backup-execution-precheck.mjs");
const authorizationValidator = path.join(root, "scripts/validate-preview-recovery-authorization.mjs");
const config = path.join(root, "wrangler.jsonc");
const plan = { formatVersion: 1, operation: "remote_backup", environment: "preview", databaseName: "cloud-genealogy-preview", databaseId: "aaaacbfb-762d-41b7-a424-aaa6e69ec563", r2Bucket: "cloud-genealogy-preview", writeFreezeId: "11111111-1111-4111-8111-111111111111", confirmedBy: ["backup-custodian-a", "backup-custodian-b"], backupId: "preview-backup-20261026", approvalRecordId: "approval-20261026-1", offsiteStorageLocationId: "offsite-vault-primary", createdAt: "2026-10-26T00:00:00.000Z" };

async function invoke(value) {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-backup-preflight-"));
  const input = path.join(directory, "plan.json"); const output = path.join(directory, "result.json");
  await writeFile(input, JSON.stringify(value), "utf8");
  return { output, directory, run: () => spawnSync(process.execPath, [script, "--plan", input, "--wrangler-config", config, "--output", output], { encoding: "utf8" }) };
}

try {
  const accepted = await invoke(plan);
  assert.equal(accepted.run().status, 0);
  assert.deepEqual(JSON.parse(await readFile(accepted.output, "utf8")), {
    formatVersion: 1,
    operation: "remote_backup_preflight",
    checkedAt: JSON.parse(await readFile(accepted.output, "utf8")).checkedAt,
    remoteExecutionAvailable: false,
    backupId: plan.backupId,
    approvalRecordId: plan.approvalRecordId,
    environment: "preview",
    databaseName: plan.databaseName,
    databaseId: plan.databaseId,
    r2Bucket: plan.r2Bucket,
    writeFreezeId: plan.writeFreezeId,
    confirmedBy: plan.confirmedBy,
    offsiteStorageLocationId: plan.offsiteStorageLocationId,
  });
  const commandPlanOutput = path.join(accepted.directory, "command-plan.json");
  const planResult = spawnSync(process.execPath, [commandPlan, "--preflight", accepted.output, "--output", commandPlanOutput], { encoding: "utf8" });
  assert.equal(planResult.status, 0);
  assert.equal(JSON.parse(await readFile(commandPlanOutput, "utf8")).remoteExecutionAvailable, false);
  const freezeRecord = path.join(accepted.directory, "freeze.json"); const precheckOutput = path.join(accepted.directory, "precheck.json");
  await writeFile(freezeRecord, JSON.stringify({ active: true, writeFreezeId: plan.writeFreezeId, approvalRecordId: plan.approvalRecordId }), "utf8");
  assert.equal(spawnSync(process.execPath, [executionPrecheck, "--preflight", accepted.output, "--command-plan", commandPlanOutput, "--freeze-record", freezeRecord, "--temp-dir", accepted.directory, "--archive-dir", accepted.directory, "--output", precheckOutput], { encoding: "utf8" }).status, 0);
  assert.equal(JSON.parse(await readFile(precheckOutput, "utf8")).remoteExecutionAvailable, false);
  const authorization = path.join(accepted.directory, "authorization.json"); const authorizationReport = path.join(accepted.directory, "authorization-report.json");
  await writeFile(authorization, JSON.stringify({ formatVersion: 1, environment: "preview", backupId: plan.backupId, approvalRecordId: plan.approvalRecordId, confirmedBy: plan.confirmedBy, windowStart: "2026-10-26T01:00:00.000Z", windowEnd: "2026-10-26T02:00:00.000Z", cleanupOwner: "preview-custodian", offsiteStorageLocationId: plan.offsiteStorageLocationId }), "utf8");
  assert.equal(spawnSync(process.execPath, [authorizationValidator, "--authorization", authorization, "--preflight", accepted.output, "--precheck", precheckOutput, "--output", authorizationReport], { encoding: "utf8" }).status, 0);
  assert.equal(JSON.parse(await readFile(authorizationReport, "utf8")).readyForHumanAuthorization, true);
  assert.equal(spawnSync(process.execPath, [executionPrecheck, "--preflight", accepted.output, "--command-plan", commandPlanOutput, "--freeze-record", freezeRecord, "--temp-dir", accepted.directory, "--archive-dir", accepted.directory, "--output", precheckOutput], { encoding: "utf8" }).status, 1);
  assert.equal(spawnSync(process.execPath, [commandPlan, "--preflight", accepted.output, "--output", commandPlanOutput], { encoding: "utf8" }).status, 1);
  const invalidPreflight = path.join(accepted.directory, "invalid-preflight.json");
  await writeFile(invalidPreflight, JSON.stringify({ remoteExecutionAvailable: false, environment: "production" }), "utf8");
  assert.equal(spawnSync(process.execPath, [commandPlan, "--preflight", invalidPreflight, "--output", path.join(accepted.directory, "invalid-output.json")], { encoding: "utf8" }).status, 1);
  const production = await invoke({ ...plan, environment: "production" });
  const productionResult = production.run();
  assert.equal(productionResult.status, 1);
  const secret = await invoke({ ...plan, apiToken: "must-not-appear" });
  const secretResult = secret.run();
  assert.equal(secretResult.status, 1);
  console.log("远程备份预检本地验证通过。");
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
