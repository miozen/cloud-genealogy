/* global Buffer */
// Isolated proof of concept. This module is not wired into the application,
// Cloudflare, D1, or R2, and must not be used to authorize a real backup.
import { createHash } from "node:crypto";

export class FencingPrototype {
  constructor(database) {
    this.db = database;
    this.objects = new Map();
    database.exec(`CREATE TABLE gate (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, frozen INTEGER NOT NULL);
      INSERT INTO gate VALUES (1, 1, 0);
      CREATE TABLE fixture_data (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE fixture_publication (asset_id TEXT PRIMARY KEY, object_key TEXT NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE fixture_audit (action TEXT NOT NULL, epoch INTEGER NOT NULL);`);
  }

  beginRequest() {
    const gate = this.db.prepare("SELECT epoch, frozen FROM gate WHERE id = 1").get();
    if (gate.frozen) throw new Error("frozen");
    return gate.epoch;
  }

  freeze() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gate = this.db.prepare("SELECT epoch, frozen FROM gate WHERE id = 1").get();
      if (gate.frozen) throw new Error("already frozen");
      this.db.prepare("UPDATE gate SET epoch = epoch + 1, frozen = 1 WHERE id = 1").run();
      this.db.prepare("INSERT INTO fixture_audit VALUES ('freeze', ?)").run(gate.epoch + 1);
      this.db.exec("COMMIT");
      return gate.epoch + 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  release() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gate = this.db.prepare("SELECT epoch, frozen FROM gate WHERE id = 1").get();
      if (!gate.frozen) throw new Error("not frozen");
      this.db.prepare("UPDATE gate SET frozen = 0 WHERE id = 1").run();
      this.db.prepare("INSERT INTO fixture_audit VALUES ('release', ?)").run(gate.epoch);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // Guard and mutation share the same SQLite transaction, unlike a separate
  // middleware check followed by a later D1 write.
  commit(epoch, id, value, failAfterWrite = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gate = this.db.prepare("SELECT epoch, frozen FROM gate WHERE id = 1").get();
      if (gate.frozen || gate.epoch !== epoch) throw new Error("stale epoch");
      this.db.prepare("INSERT INTO fixture_data VALUES (?, ?)").run(id, value);
      if (failAfterWrite) throw new Error("injected failure");
      this.db.prepare("INSERT INTO fixture_audit VALUES ('write', ?)").run(epoch);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  putStaging(epoch, id, contents) {
    const key = `staging/${epoch}/${id}`;
    this.objects.set(key, Buffer.from(contents));
    return key;
  }

  publish(epoch, id, expectedSha256, failAfterCopy = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gate = this.db.prepare("SELECT epoch, frozen FROM gate WHERE id = 1").get();
      if (gate.frozen || gate.epoch !== epoch) throw new Error("stale epoch");
      const source = this.objects.get(`staging/${epoch}/${id}`);
      if (!source || createHash("sha256").update(source).digest("hex") !== expectedSha256) throw new Error("object mismatch");
      // The immutable published copy models isolation, not real R2 semantics.
      const key = `published/${epoch}/${id}`;
      if (this.objects.has(key)) throw new Error("already published");
      this.objects.set(key, Buffer.from(source));
      if (failAfterCopy) throw new Error("injected copy interruption");
      this.db.prepare("INSERT INTO fixture_publication VALUES (?, ?, ?)").run(id, key, expectedSha256);
      this.db.prepare("INSERT INTO fixture_audit VALUES ('publish', ?)").run(epoch);
      this.db.exec("COMMIT");
      return key;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
