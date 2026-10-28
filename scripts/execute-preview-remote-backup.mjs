#!/usr/bin/env node
/* global console, process */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);

// Snapshot must be supplied by a trusted adapter, not an operator-authored
// JSON assertion. No production adapter currently exists.
export function requireQuiescence(snapshot, expectedFreezeId) {
  if (!snapshot || typeof expectedFreezeId !== "string" || !expectedFreezeId || snapshot.freezeId !== expectedFreezeId || snapshot.freezeActive !== true || snapshot.activeWrites !== 0 || snapshot.pendingUploads !== 0) {
    throw new Error("Backup is not quiescent: freeze, in-flight writes or pending uploads require attention.");
  }
}

// Only injected local test adapters are supported. The CLI remains disabled.
export async function runMockBackup({ output, migrationDir, gitCommit, adapter, freezeId }) {
  if (!path.isAbsolute(output) || !path.isAbsolute(migrationDir)) throw new Error("Absolute paths required.");
  requireQuiescence(await adapter.quiescence(), freezeId);
  await mkdir(output, { mode: 0o700 });
  try {
    const packageDir = path.join(output, "package");
    await mkdir(path.join(packageDir, "d1"), { recursive: true, mode: 0o700 });
    await adapter.exportD1(path.join(packageDir, "d1", "schema-and-data.sql"));
    const inventory = await adapter.inventory();
    if (inventory?.formatVersion !== 2 || inventory.source !== "local_d1" || !Array.isArray(inventory.mediaAssets)) throw new Error("Invalid fixture inventory.");
    for (const asset of inventory.mediaAssets) {
      if (!/^media\/[a-zA-Z0-9_-]+$/u.test(asset.objectKey)) throw new Error("Unsafe object key.");
      const objectPath = path.join(packageDir, "r2", asset.objectKey);
      await mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
      await adapter.downloadObject(asset.objectKey, objectPath);
    }
    // Catch an invalidated freeze or newly observed activity before manifest.
    requireQuiescence(await adapter.quiescence(), freezeId);
    const countsFile = path.join(output, "counts.json");
    await writeFile(countsFile, JSON.stringify(inventory), { flag: "wx", mode: 0o600 });
    const script = path.join(import.meta.dirname, "backup-package.mjs");
    await execute(process.execPath, [script, "create", "--package", packageDir, "--migration-dir", migrationDir, "--source-environment", "local", "--git-commit", gitCommit, "--counts-file", countsFile]);
    await execute(process.execPath, [script, "verify", "--package", packageDir, "--migration-dir", migrationDir]);
    return JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8"));
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  console.error("Remote execution is unavailable: preview authorization, write quiescence and remote inventory are not implemented.");
  process.exitCode = 1;
}
