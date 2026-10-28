/* global Buffer, console */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CrossStoreRecoveryPrototype } from "./cross-store-recovery-prototype.mjs";

const db = new DatabaseSync(":memory:");
const objects = new Map();
const bytes = Buffer.from("local fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
try {
  let run = new CrossStoreRecoveryPrototype(db, objects);
  const item = run.prepare("a", 1, hash);
  assert.equal(item.state, "prepared");
  assert.throws(() => run.copy("a", bytes, { interruptAfterCopy: true }), /interruption/u);
  assert.equal(run.item("a").state, "prepared");
  assert.equal(objects.has(item.object_key), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recovery_publication").get().n, 0);
  // New process instance sees the durable item and the same fixture store.
  run = new CrossStoreRecoveryPrototype(db, objects);
  assert.equal(run.copy("a", bytes).state, "copied");
  assert.throws(() => run.finalize("a", { interruptAfterPublication: true }), /interruption/u);
  assert.equal(run.item("a").state, "copied");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recovery_publication").get().n, 0);
  assert.equal(run.finalize("a").state, "published");
  assert.equal(run.finalize("a").state, "published");
  assert.deepEqual(db.prepare("SELECT action FROM recovery_audit WHERE item_id = 'a' ORDER BY id").all().map((row) => row.action), ["prepared", "copied", "published"]);
  assert.throws(() => run.prepare("a", 1, "0".repeat(64)), /conflict/u);

  const mismatch = run.prepare("mismatch", 1, hash);
  assert.throws(() => run.copy("mismatch", Buffer.from("wrong")), /source hash mismatch/u);
  objects.set(mismatch.object_key, Buffer.from("unrelated existing object"));
  assert.throws(() => run.copy("mismatch", bytes), /destination hash mismatch/u);
  assert.equal(objects.get(mismatch.object_key).toString(), "unrelated existing object");
  assert.equal(run.item("mismatch").state, "prepared");

  run.prepare("missing", 1, hash);
  run.copy("missing", bytes);
  objects.delete(run.item("missing").object_key);
  assert.throws(() => run.finalize("missing"), /missing or changed/u);
  assert.equal(run.item("missing").state, "copied");

  run.prepare("stale", 1, hash);
  assert.throws(() => run.copy("stale", bytes, { interruptAfterCopy: true }), /interruption/u);
  run.freeze();
  assert.throws(() => run.copy("stale", bytes), /stale or frozen/u);
  assert.throws(() => run.flagForReview("stale", "operator review"), /freeze active/u);
  run.release();
  assert.throws(() => run.copy("stale", bytes), /stale or frozen/u);
  assert.equal(run.item("stale").state, "prepared");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recovery_publication WHERE id = 'stale'").get().n, 0);
  assert.equal(run.flagForReview("stale", "old epoch needs independent review").state, "needs_review");
  assert.equal(run.flagForReview("stale", "old epoch needs independent review").state, "needs_review");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recovery_audit WHERE item_id = 'stale' AND action LIKE 'review_required:%'").get().n, 1);
  assert.equal(objects.has(run.item("stale").object_key), true);
  console.log("Cross-store recovery prototype: interruption, retry, corruption, audit and stale epoch passed.");
} finally { db.close(); }
