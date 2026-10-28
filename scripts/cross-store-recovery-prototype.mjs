/* global Buffer */
// Local-only model: SQLite + in-memory object store. No D1/R2 bindings.
import { createHash } from "node:crypto";

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function safeId(id) { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error("invalid item id"); }

export class CrossStoreRecoveryPrototype {
  constructor(db, objects = new Map()) {
    this.db = db;
    this.objects = objects;
    db.exec(`CREATE TABLE IF NOT EXISTS recovery_gate (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, frozen INTEGER NOT NULL);
      INSERT OR IGNORE INTO recovery_gate VALUES (1, 1, 0);
      CREATE TABLE IF NOT EXISTS recovery_item (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE, expected_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'copied', 'published', 'needs_review')));
      CREATE TABLE IF NOT EXISTS recovery_publication (id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_audit (id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, action TEXT NOT NULL, epoch INTEGER NOT NULL);`);
  }

  gate() { return this.db.prepare("SELECT epoch, frozen FROM recovery_gate WHERE id = 1").get(); }
  item(id) { return this.db.prepare("SELECT id, epoch, object_key, expected_sha256, state FROM recovery_item WHERE id = ?").get(id); }
  requireEpoch(epoch) { const gate = this.gate(); if (gate.frozen || gate.epoch !== epoch) throw new Error("stale or frozen epoch"); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  audit(id, action, epoch) { this.db.prepare("INSERT INTO recovery_audit (item_id, action, epoch) VALUES (?, ?, ?)").run(id, action, epoch); }

  freeze() { return this.transaction(() => { const gate = this.gate(); if (gate.frozen) throw new Error("already frozen"); this.db.prepare("UPDATE recovery_gate SET epoch = epoch + 1, frozen = 1 WHERE id = 1").run(); return gate.epoch + 1; }); }
  release() { return this.transaction(() => { if (!this.gate().frozen) throw new Error("not frozen"); this.db.prepare("UPDATE recovery_gate SET frozen = 0 WHERE id = 1").run(); }); }

  prepare(id, epoch, expectedSha256) {
    safeId(id);
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error("invalid hash");
    return this.transaction(() => {
      this.requireEpoch(epoch);
      const existing = this.item(id);
      if (existing) {
        if (existing.epoch !== epoch || existing.expected_sha256 !== expectedSha256) throw new Error("item conflict");
        return existing;
      }
      const key = `published/${epoch}/${id}`;
      this.db.prepare("INSERT INTO recovery_item VALUES (?, ?, ?, ?, 'prepared')").run(id, epoch, key, expectedSha256);
      this.audit(id, "prepared", epoch);
      return this.item(id);
    });
  }

  // The caller controls only the fixture store; an existing key is never overwritten.
  copy(id, bytes, { interruptAfterCopy = false } = {}) {
    const item = this.item(id);
    if (!item) throw new Error("item not prepared");
    this.requireEpoch(item.epoch);
    if (item.state === "needs_review") throw new Error("item requires manual review");
    if (digest(bytes) !== item.expected_sha256) throw new Error("source hash mismatch");
    const existing = this.objects.get(item.object_key);
    if (existing && digest(existing) !== item.expected_sha256) throw new Error("destination hash mismatch");
    if (!existing) this.objects.set(item.object_key, Buffer.from(bytes));
    if (interruptAfterCopy) throw new Error("injected interruption after copy");
    return this.transaction(() => {
      this.requireEpoch(item.epoch);
      const current = this.item(id);
      if (current.state === "prepared") {
        this.db.prepare("UPDATE recovery_item SET state = 'copied' WHERE id = ? AND state = 'prepared'").run(id);
        this.audit(id, "copied", item.epoch);
      }
      return this.item(id);
    });
  }

  finalize(id, { interruptAfterPublication = false } = {}) {
    return this.transaction(() => {
      const item = this.item(id);
      if (!item) throw new Error("item not prepared");
      this.requireEpoch(item.epoch);
      const object = this.objects.get(item.object_key);
      if (!object || digest(object) !== item.expected_sha256) throw new Error("destination missing or changed");
      const publication = this.db.prepare("SELECT object_key, sha256 FROM recovery_publication WHERE id = ?").get(id);
      if (item.state === "published") {
        if (!publication || publication.object_key !== item.object_key || publication.sha256 !== item.expected_sha256) throw new Error("publication mismatch");
        return item;
      }
      if (item.state !== "copied" || publication) throw new Error("item not ready to finalize");
      this.db.prepare("INSERT INTO recovery_publication VALUES (?, ?, ?)").run(id, item.object_key, item.expected_sha256);
      if (interruptAfterPublication) throw new Error("injected finalization interruption");
      this.db.prepare("UPDATE recovery_item SET state = 'published' WHERE id = ? AND state = 'copied'").run(id);
      this.audit(id, "published", item.epoch);
      return this.item(id);
    });
  }

  flagForReview(id, reason) {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) throw new Error("review reason required");
    return this.transaction(() => {
      const item = this.item(id); const gate = this.gate();
      if (!item) throw new Error("item not prepared");
      if (gate.frozen) throw new Error("freeze active");
      if (item.state === "published") throw new Error("published item cannot be flagged");
      if (item.state === "needs_review") return item;
      this.db.prepare("UPDATE recovery_item SET state = 'needs_review' WHERE id = ?").run(id);
      this.audit(id, `review_required: ${reason.trim()}`, gate.epoch);
      return this.item(id);
    });
  }
}
