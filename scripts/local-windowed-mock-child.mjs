/* global process, Buffer */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
import { runLocalWindowedMock } from "./local-windowed-mock-backup.mjs";
const [dbFile, output, stopStage] = process.argv.slice(2);
const db = new DatabaseSync(dbFile); const model = new LocalBackupWindowFixture(db);
const bytes = "isolated object";
const inventory = { formatVersion: 2, source: "local_d1", counts: { person: 1 }, mediaAssets: [{ mediaAssetId: "11111111-1111-4111-8111-111111111111", objectKey: "media/fixture", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: Buffer.byteLength(bytes), mimeType: "image/jpeg", state: "active", activeReferenceCount: 1 }] };
const adapter = { quiescence: async () => ({ freezeId: "freeze", freezeActive: true, activeWrites: 0, pendingUploads: 0 }), exportD1: (file) => writeFile(file, "-- fixture\n"), inventory: async () => inventory, downloadObject: (_key, file) => writeFile(file, bytes) };
function pause(stage) {
  if (stage === stopStage) { writeSync(1, `checkpoint:${stage}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
}
await runLocalWindowedMock({ output, migrationDir: path.resolve("migrations"), gitCommit: "abcdef1", adapter, freezeId: "freeze", model, windowId: "window", owner: "owner", now: () => 3,
  afterStage: async (stage) => pause(stage), beforePublish: async () => pause("before_publish"), afterRenameBeforeCommit: () => pause("after_rename_before_commit"), afterPublish: async () => pause("after_publish"),
});
db.close();
