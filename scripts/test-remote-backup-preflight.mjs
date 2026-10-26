#!/usr/bin/env node
/* global console, process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/remote-backup-preflight.mjs");
const config = path.join(root, "wrangler.jsonc");
const plan = { formatVersion: 1, operation: "remote_backup", environment: "preview", databaseName: "cloud-genealogy-preview", databaseId: "aaaacbfb-762d-41b7-a424-aaa6e69ec563", r2Bucket: "cloud-genealogy-preview", writeFreezeId: "11111111-1111-4111-8111-111111111111", confirmedBy: ["backup-custodian-a", "backup-custodian-b"], backupId: "preview-backup-20261026", approvalRecordId: "approval-20261026-1", offsiteStorageLocationId: "offsite-vault-primary", createdAt: "2026-10-26T00:00:00.000Z" };

async function invoke(value) {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-backup-preflight-"));
  const input = path.join(directory, "plan.json"); const output = path.join(directory, "result.json");
  await writeFile(input, JSON.stringify(value), "utf8");
  return { output, run: () => spawnSync(process.execPath, [script, "--plan", input, "--wrangler-config", config, "--output", output], { encoding: "utf8" }) };
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
