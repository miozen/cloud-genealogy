/* global Buffer */
// Local test fixture only. This is not a trusted key store or approval API.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isFixtureScope, verifyFixtureSignature } from "./local-orphan-signature-fixture.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const challengePattern = /^[0-9a-f]{64}$/u;
const same = (left, right) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
function keyFingerprint(key) {
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("challenge_key_invalid");
  return hash(key.export({ type: "spki", format: "der" }));
}
function safeRoot(root) {
  const parent = realpathSync(tmpdir()); const resolved = path.resolve(root);
  if (path.dirname(resolved) !== parent || !/^cg-local-challenge-[A-Za-z0-9]+$/u.test(path.basename(resolved))) throw new Error("challenge_root_invalid");
  const stat = lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resolved) !== resolved) throw new Error("challenge_root_invalid");
  return { root: resolved, dev: String(stat.dev), ino: String(stat.ino) };
}
class ChallengeFixture {
  constructor(root, capability, publicKey) {
    const identity = safeRoot(root); this.root = identity.root; this.publicKey = publicKey;
    const database = path.join(identity.root, "challenge.sqlite"); const stat = lstatSync(database, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || path.dirname(realpathSync(database)) !== identity.root) throw new Error("challenge_database_invalid");
    this.db = new DatabaseSync(database); this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    try {
      const meta = this.db.prepare("SELECT root_dev,root_ino,capability_hash,key_hash FROM fixture_challenge_meta WHERE id=1").get();
      if (!meta || typeof capability !== "string" || identity.dev !== meta.root_dev || identity.ino !== meta.root_ino || !same(hash(capability), meta.capability_hash) || !same(keyFingerprint(publicKey), meta.key_hash)) throw new Error("challenge_identity_invalid");
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  issue(scope) {
    if (!isFixtureScope(scope)) throw new Error("challenge_scope_invalid");
    const challenge = randomBytes(32).toString("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO fixture_challenge(challenge,run_id,root_id,attempt_id,consumed) VALUES(?,?,?,?,0)").run(challenge, scope.runId, scope.rootId, scope.attemptId);
      this.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'issued')").run(challenge);
      this.db.exec("COMMIT"); return challenge;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  consume(envelope, { beforeCommit = () => {}, afterCommit = () => {} } = {}) {
    const challenge = envelope?.payload?.challenge;
    if (typeof challenge !== "string" || !challengePattern.test(challenge)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    let consumed = false;
    try {
      const row = this.db.prepare("SELECT run_id,root_id,attempt_id,consumed FROM fixture_challenge WHERE challenge=?").get(challenge);
      const scope = row && { runId: row.run_id, rootId: row.root_id, attemptId: row.attempt_id };
      if (!row || row.consumed !== 0 || !verifyFixtureSignature(this.publicKey, envelope, scope, challenge)) { this.db.exec("ROLLBACK"); return false; }
      const updated = this.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=? AND consumed=0").run(challenge);
      if (updated.changes !== 1) throw new Error("challenge_state_changed");
      this.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'consumed')").run(challenge);
      beforeCommit(); this.db.exec("COMMIT"); consumed = true;
    } catch (error) { if (!consumed) this.db.exec("ROLLBACK"); throw error; }
    afterCommit(); return true;
  }
}
export function createLocalChallengeFixture(publicKey) {
  const fingerprint = keyFingerprint(publicKey);
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "cg-local-challenge-")); const capability = randomBytes(32).toString("hex");
  const identity = safeRoot(root); const db = new DatabaseSync(path.join(root, "challenge.sqlite"));
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE fixture_challenge_meta(id INTEGER PRIMARY KEY,root_dev TEXT NOT NULL,root_ino TEXT NOT NULL,capability_hash TEXT NOT NULL,key_hash TEXT NOT NULL);
      CREATE TABLE fixture_challenge(challenge TEXT PRIMARY KEY,run_id TEXT NOT NULL,root_id TEXT NOT NULL,attempt_id TEXT NOT NULL,consumed INTEGER NOT NULL CHECK(consumed IN (0,1)));
      CREATE TABLE fixture_challenge_audit(id INTEGER PRIMARY KEY,challenge TEXT NOT NULL REFERENCES fixture_challenge(challenge),action TEXT NOT NULL CHECK(action IN ('issued','consumed')),UNIQUE(challenge,action));
      CREATE TRIGGER fixture_challenge_audit_no_update BEFORE UPDATE ON fixture_challenge_audit BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;
      CREATE TRIGGER fixture_challenge_audit_no_delete BEFORE DELETE ON fixture_challenge_audit BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;`);
    db.prepare("INSERT INTO fixture_challenge_meta VALUES(1,?,?,?,?)").run(identity.dev, identity.ino, hash(capability), fingerprint);
  } finally { db.close(); }
  return { root, capability, fixture: new ChallengeFixture(root, capability, publicKey) };
}
export function reopenLocalChallengeFixture(root, capability, publicKey) { return new ChallengeFixture(root, capability, publicKey); }
