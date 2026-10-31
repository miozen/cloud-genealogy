/* global Buffer */
// TEST FIXTURE ONLY: creates its own private temporary root. This is not a
// general-purpose cleanup tool, Cloudflare adapter, or trusted stop proof.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, fstatSync, lstatSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const allowedDirectories = new Set([".fixture-staging", ".fixture-staging/package", ".fixture-staging/package/d1", ".fixture-staging/package/r2", ".fixture-staging/package/r2/media", "complete", "complete/package", "complete/package/d1", "complete/package/r2", "complete/package/r2/media"]);
const allowedFiles = new Set([".fixture-owner.json", ".fixture-staging/counts.json", ".fixture-staging/fixture-complete.json", ".fixture-staging/package/manifest.json", ".fixture-staging/package/d1/schema-and-data.sql", ".fixture-staging/package/r2/media/fixture", "complete/counts.json", "complete/fixture-complete.json", "complete/package/manifest.json", "complete/package/d1/schema-and-data.sql", "complete/package/r2/media/fixture"]);
function validId(id) { if (typeof id !== "string" || !idPattern.test(id)) throw new Error("invalid_attempt_id"); }
function entryExists(filename) { try { lstatSync(filename); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function markerRead(filename) {
  const info = lstatSync(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 4096n) throw new Error("owner_marker_invalid");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const actual = fstatSync(fd, { bigint: true }); if (!same(identity(info), identity(actual))) throw new Error("owner_marker_changed"); return JSON.parse(readFileSync(fd, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("owner_marker_invalid"); throw error; }
  finally { closeSync(fd); }
}

class Fixture {
  constructor(root, capability, stopped) {
    const parent = realpathSync(tmpdir()); const resolved = path.resolve(root);
    if (path.dirname(resolved) !== parent || !/^cg-local-orphan-[A-Za-z0-9]+$/u.test(path.basename(resolved))) throw new Error("fixture_root_invalid");
    const stat = lstatSync(resolved, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resolved) !== resolved) throw new Error("fixture_root_invalid");
    this.root = resolved; this.rootId = identity(stat); this.stopped = stopped;
    const dbFile = path.join(resolved, "fixture.sqlite"); const dbStat = lstatSync(dbFile, { bigint: true });
    if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink !== 1n || path.dirname(realpathSync(dbFile)) !== resolved) throw new Error("fixture_database_invalid");
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const meta = this.db.prepare("SELECT capability_hash, root_dev, root_ino FROM fixture_orphan_meta WHERE id=1").get();
    if (!meta || typeof capability !== "string" || !same(this.rootId, { dev: meta.root_dev, ino: meta.root_ino }) || !timingSafeEqual(Buffer.from(hash(capability), "hex"), Buffer.from(meta.capability_hash, "hex"))) { this.db.close(); throw new Error("fixture_capability_invalid"); }
  }
  close() { this.db.close(); }
  verifyRoot() {
    const info = lstatSync(this.root, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || !same(identity(info), this.rootId) || realpathSync(this.root) !== this.root) throw new Error("fixture_root_changed");
  }
  tx(fn) { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  audit(id, action, detail = "") { this.db.prepare("INSERT INTO fixture_orphan_audit(attempt_id,action,detail) VALUES (?,?,?)").run(id, action, detail); }
  record(id) { validId(id); return this.db.prepare("SELECT * FROM fixture_orphan_attempt WHERE id=?").get(id); }
  output(id) { validId(id); return path.join(this.root, `attempt-${id}`); }
  plan(windowId) {
    this.verifyRoot(); if (typeof windowId !== "string" || !windowId.trim()) throw new Error("window_required");
    const id = randomUUID(); const nonce = randomBytes(32).toString("hex");
    this.tx(() => { this.db.prepare("INSERT INTO fixture_orphan_attempt(id,window_id,nonce_hash,state) VALUES (?,?,?,'planned')").run(id, windowId, hash(nonce)); this.audit(id, "planned"); });
    return { id, output: this.output(id), nonce };
  }
  // Called by a supervisor only for a planned path within its private root.
  attest(id, nonce) {
    this.verifyRoot(); const row = this.record(id); if (!row || row.state !== "planned" || hash(nonce) !== row.nonce_hash) throw new Error("attempt_not_planned");
    const dir = this.output(id); const stat = lstatSync(dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(realpathSync(dir)) !== this.root) throw new Error("attempt_directory_invalid");
    const fileId = identity(stat); const marker = { fixtureOnly: true, attemptId: id, windowId: row.window_id, nonce, ...fileId };
    writeFileSync(path.join(dir, ".fixture-owner.json"), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
    this.tx(() => { this.db.prepare("UPDATE fixture_orphan_attempt SET state='owned',device=?,inode=? WHERE id=? AND state='planned'").run(fileId.dev, fileId.ino, id); this.audit(id, "attested", `${fileId.dev}:${fileId.ino}`); });
  }
  validateTree(id, row) {
    this.verifyRoot(); const dir = this.output(id); const stat = lstatSync(dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(identity(stat), { dev: row.device, ino: row.inode }) || path.dirname(realpathSync(dir)) !== this.root) throw new Error("attempt_identity_changed");
    const marker = markerRead(path.join(dir, ".fixture-owner.json"));
    if (marker.fixtureOnly !== true || marker.attemptId !== id || marker.windowId !== row.window_id || marker.dev !== row.device || marker.ino !== row.inode || typeof marker.nonce !== "string" || hash(marker.nonce) !== row.nonce_hash) throw new Error("owner_marker_mismatch");
    const walk = (parent, prefix = "") => {
      for (const name of readdirSync(parent)) {
        const rel = prefix ? `${prefix}/${name}` : name; const file = path.join(parent, name); const info = lstatSync(file, { bigint: true });
        if (info.isSymbolicLink()) throw new Error("fixture_symlink_forbidden");
        if (info.isDirectory()) { if (!allowedDirectories.has(rel)) throw new Error("unrecognized_fixture_entry"); walk(file, rel); }
        else if (!info.isFile() || info.nlink !== 1n || !allowedFiles.has(rel)) throw new Error("unrecognized_fixture_entry");
      }
    };
    walk(dir);
    if (entryExists(path.join(dir, ".fixture-staging")) && entryExists(path.join(dir, "complete"))) throw new Error("ambiguous_fixture_layout");
    return dir;
  }
  recover(id, { remove = (dir) => rmSync(dir, { recursive: true }), beforeRemove = () => {}, afterRemove = () => {} } = {}) {
    this.verifyRoot(); validId(id); if (typeof this.stopped !== "function" || this.stopped() !== true) throw new Error("supervisor_not_stopped");
    const dir = this.output(id);
    const inspect = () => {
      this.verifyRoot(); if (this.stopped() !== true) throw new Error("supervisor_not_stopped");
      const row = this.record(id); if (!row || row.state === "planned") throw new Error("attempt_not_attested");
      if (row.state === "cleaned") {
        if (entryExists(dir)) throw new Error("cleaned_path_reappeared");
        return { row, terminal: "cleaned" };
      }
      const window = this.db.prepare("SELECT state FROM fixture_backup_window WHERE id=?").get(row.window_id);
      if (!window) throw new Error("window_missing");
      if (window.state === "held") throw new Error("window_still_held");
      if (window.state === "completed") { this.validateTree(id, row); return { row, terminal: "preserved" }; }
      if (window.state !== "invalidated" || row.state === "preserved") throw new Error("window_not_recoverable");
      const present = entryExists(dir);
      if (!present && row.state !== "cleaning") throw new Error("attempt_missing_without_cleanup_intent");
      if (present) this.validateTree(id, row);
      return { row, present };
    };
    // Durable intent is committed before deletion. A second SQLite write
    // transaction serializes competing fixture recovery processes while the
    // filesystem is inspected, removed, and the completion audit is written.
    const intent = this.tx(() => {
      const state = inspect();
      if (state.terminal === "cleaned") return { state: "cleaned", alreadyApplied: true, remoteExecutionAvailable: false };
      if (state.terminal === "preserved") {
        if (state.row.state !== "preserved") { this.db.prepare("UPDATE fixture_orphan_attempt SET state='preserved' WHERE id=?").run(id); this.audit(id, "preserved", "completed_window"); }
        return { state: "preserved", alreadyApplied: state.row.state === "preserved", remoteExecutionAvailable: false };
      }
      if (state.row.state !== "cleaning") { this.db.prepare("UPDATE fixture_orphan_attempt SET state='cleaning' WHERE id=?").run(id); this.audit(id, "cleanup_started"); }
      return null;
    });
    if (intent) return intent;
    try {
      return this.tx(() => {
        const state = inspect();
        if (state.terminal === "cleaned") return { state: "cleaned", alreadyApplied: true, remoteExecutionAvailable: false };
        if (state.terminal || state.row.state !== "cleaning") throw new Error("cleanup_state_changed");
        if (state.present) {
          beforeRemove();
          if (this.stopped() !== true) throw new Error("supervisor_not_stopped");
          this.validateTree(id, state.row);
          remove(dir);
          afterRemove();
        }
        this.db.prepare("UPDATE fixture_orphan_attempt SET state='cleaned' WHERE id=? AND state='cleaning'").run(id);
        this.audit(id, "cleanup_completed");
        return { state: "cleaned", alreadyApplied: false, remoteExecutionAvailable: false };
      });
    } catch (error) {
      // A competing recovery may already have completed. Never overwrite its
      // terminal state or append a false failure record.
      if (entryExists(dir)) this.tx(() => {
        const current = this.record(id);
        if (current?.state === "cleaning") { this.db.prepare("UPDATE fixture_orphan_attempt SET state='failed' WHERE id=? AND state='cleaning'").run(id); this.audit(id, "cleanup_failed", error instanceof Error ? error.message : "unknown"); }
      });
      throw error;
    }
  }

}

export function createLocalOrphanFixture(stopped) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "cg-local-orphan-")); const capability = randomBytes(32).toString("hex");
  const stat = lstatSync(root, { bigint: true }); const rootId = identity(stat); const db = new DatabaseSync(path.join(root, "fixture.sqlite"));
  db.exec(`CREATE TABLE fixture_orphan_meta(id INTEGER PRIMARY KEY, capability_hash TEXT NOT NULL, root_dev TEXT NOT NULL, root_ino TEXT NOT NULL);
    CREATE TABLE fixture_orphan_attempt(id TEXT PRIMARY KEY, window_id TEXT NOT NULL, nonce_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('planned','owned','cleaning','failed','cleaned','preserved')), device TEXT, inode TEXT);
    CREATE TABLE fixture_orphan_audit(id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES fixture_orphan_attempt(id), action TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TRIGGER fixture_orphan_audit_no_update BEFORE UPDATE ON fixture_orphan_audit BEGIN SELECT RAISE(ABORT, 'audit_immutable'); END;
    CREATE TRIGGER fixture_orphan_audit_no_delete BEFORE DELETE ON fixture_orphan_audit BEGIN SELECT RAISE(ABORT, 'audit_immutable'); END;`);
  db.prepare("INSERT INTO fixture_orphan_meta VALUES(1,?,?,?)").run(hash(capability), rootId.dev, rootId.ino); db.close();
  return { root, capability, fixture: new Fixture(root, capability, stopped) };
}
export function reopenLocalOrphanFixture(root, capability, stopped) { return new Fixture(root, capability, stopped); }
