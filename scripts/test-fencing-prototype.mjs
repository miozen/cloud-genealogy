/* global console */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FencingPrototype } from "./fencing-prototype.mjs";

const db = new DatabaseSync(":memory:");
try {
  const prototype = new FencingPrototype(db);
  const oldEpoch = prototype.beginRequest();
  prototype.commit(oldEpoch, "before", "ok");
  prototype.putStaging(oldEpoch, "asset", "original");
  const hash = createHash("sha256").update("original").digest("hex");
  const published = prototype.publish(oldEpoch, "asset", hash);
  assert.equal(prototype.freeze(), oldEpoch + 1);
  assert.throws(() => prototype.beginRequest(), /frozen/u);
  assert.throws(() => prototype.commit(oldEpoch, "during", "bad"), /stale epoch/u);
  // Simulate an already issued URL used again after the freeze.
  prototype.putStaging(oldEpoch, "asset", "late overwrite");
  assert.equal(prototype.objects.get(published).toString(), "original");
  assert.throws(() => prototype.publish(oldEpoch, "later", hash), /stale epoch/u);
  prototype.release();
  assert.throws(() => prototype.commit(oldEpoch, "resumed", "bad"), /stale epoch/u);
  const newEpoch = prototype.beginRequest();
  assert.throws(() => prototype.commit(newEpoch, "interrupted", "bad", true), /injected failure/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture_data WHERE id = 'interrupted'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture_audit WHERE action = 'write'").get().count, 1);
  prototype.commit(newEpoch, "after", "ok");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture_data").get().count, 2);
  prototype.putStaging(newEpoch, "orphan", "original");
  assert.throws(() => prototype.publish(newEpoch, "orphan", hash, true), /injected copy interruption/u);
  assert.equal(prototype.objects.has(`published/${newEpoch}/orphan`), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fixture_publication WHERE asset_id = 'orphan'").get().count, 0);
  assert.throws(() => prototype.publish(newEpoch, "orphan", hash), /already published/u);
  console.log("SQLite fencing and isolated staging prototype fault injection passed.");
} finally { db.close(); }
