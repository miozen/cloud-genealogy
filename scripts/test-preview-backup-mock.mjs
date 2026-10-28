/* global console, Buffer */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMockBackup } from "./execute-preview-remote-backup.mjs";

const root = await mkdtemp(path.join(tmpdir(), "cg-backup-mock-"));
const bytes = "isolated mock object";
const inventory = { formatVersion: 2, source: "local_d1", counts: { person: 1 }, mediaAssets: [{ mediaAssetId: "11111111-1111-4111-8111-111111111111", objectKey: "media/fixture", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: Buffer.byteLength(bytes), mimeType: "image/jpeg", state: "active", activeReferenceCount: 1 }] };
const stable = { freezeId: "freeze-1", freezeActive: true, activeWrites: 0, pendingUploads: 0 };
const adapter = { quiescence: async () => stable, exportD1: (file) => writeFile(file, "-- mock D1 export\n"), inventory: async () => inventory, downloadObject: (_key, file) => writeFile(file, bytes) };
try {
  const options = { output: path.join(root, "success"), migrationDir: path.resolve("migrations"), gitCommit: "abcdef1", freezeId: "freeze-1", adapter };
  const manifest = await runMockBackup(options);
  assert.equal(manifest.sourceEnvironment, "local");
  assert.equal(manifest.mediaAssets.length, 1);
  assert.equal(await readFile(path.join(options.output, "package/r2/media/fixture"), "utf8"), bytes);
  await assert.rejects(runMockBackup(options));
  assert.equal((await stat(options.output)).isDirectory(), true);
  const failed = path.join(root, "failed");
  await assert.rejects(runMockBackup({ ...options, output: failed, adapter: { ...adapter, downloadObject: async () => { throw new Error("simulated R2 failure"); } } }));
  await assert.rejects(stat(failed), { code: "ENOENT" });
  const corrupt = path.join(root, "corrupt");
  await assert.rejects(runMockBackup({ ...options, output: corrupt, adapter: { ...adapter, downloadObject: (_key, file) => writeFile(file, "wrong") } }));
  await assert.rejects(stat(corrupt), { code: "ENOENT" });
  for (const [name, state] of Object.entries({ running: { ...stable, activeWrites: 1 }, upload: { ...stable, pendingUploads: 1 }, released: { ...stable, freezeActive: false }, wrongFreeze: { ...stable, freezeId: "other" } })) {
    const target = path.join(root, name);
    await assert.rejects(runMockBackup({ ...options, output: target, adapter: { ...adapter, quiescence: async () => state } }), /not quiescent/u);
    await assert.rejects(stat(target), { code: "ENOENT" });
  }
  let checks = 0;
  const drift = path.join(root, "drift");
  await assert.rejects(runMockBackup({ ...options, output: drift, adapter: { ...adapter, quiescence: async () => ++checks === 1 ? stable : { ...stable, freezeActive: false } } }), /not quiescent/u);
  await assert.rejects(stat(drift), { code: "ENOENT" });
  console.log("Mock backup and quiescence fault injection passed.");
} finally { await rm(root, { recursive: true, force: true }); }
