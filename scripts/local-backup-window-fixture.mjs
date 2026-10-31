// Isolated SQLite model only. It does not call Wrangler, R2, or export data.
// Synthetic evidence and caller-provided time are not a production trust source.
const steps = ["d1_export", "media_inventory", "media_download", "verify", "finalize"];
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export class LocalBackupWindowFixture {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS fixture_window_gate (id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL, freeze_id TEXT, last_time INTEGER NOT NULL);
      INSERT OR IGNORE INTO fixture_window_gate VALUES (1, 0, NULL, 0);
      CREATE TABLE IF NOT EXISTS fixture_window_freeze (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fixture_window_evidence (id TEXT PRIMARY KEY, freeze_id TEXT NOT NULL, epoch INTEGER NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fixture_backup_window (id TEXT PRIMARY KEY, freeze_id TEXT NOT NULL, epoch INTEGER NOT NULL, owner TEXT NOT NULL, evidence_id TEXT NOT NULL, evidence_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','invalidated','completed')), step_index INTEGER NOT NULL DEFAULT 0, inflight TEXT, failure TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS fixture_one_window ON fixture_backup_window((1)) WHERE state = 'held';
      CREATE TABLE IF NOT EXISTS fixture_window_audit (id INTEGER PRIMARY KEY, window_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  tx(fn, beforeCommit = () => {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); beforeCommit(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  gate() { return this.db.prepare("SELECT * FROM fixture_window_gate WHERE id=1").get(); }
  window(id) { return this.db.prepare("SELECT * FROM fixture_backup_window WHERE id=?").get(id); }
  audit(id, action, detail) { this.db.prepare("INSERT INTO fixture_window_audit(window_id,action,detail) VALUES(?,?,?)").run(id, action, detail); }
  clock(now) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_clock");
    const last = this.gate().last_time;
    if (now < last) return false;
    this.db.prepare("UPDATE fixture_window_gate SET last_time=? WHERE id=1").run(now);
    return true;
  }
  invalidate(id, reason) {
    const result = this.db.prepare("UPDATE fixture_backup_window SET state='invalidated', failure=?, inflight=NULL WHERE id=? AND state='held'").run(reason, id);
    if (result.changes) this.audit(id, "invalidated", reason);
  }
  freeze(id, now) {
    if (!nonempty(id)) throw new Error("invalid_freeze_id");
    return this.tx(() => {
      if (!this.clock(now)) throw new Error("clock_rollback");
      const gate = this.gate();
      if (gate.freeze_id !== null) throw new Error("freeze_active");
      const epoch = gate.epoch + 1;
      this.db.prepare("INSERT INTO fixture_window_freeze (id, epoch) VALUES (?,?)").run(id, epoch);
      this.db.prepare("UPDATE fixture_window_gate SET freeze_id=?,epoch=? WHERE id=1").run(id, epoch);
      return epoch;
    });
  }
  release(id, now) {
    if (!nonempty(id)) throw new Error("invalid_freeze_id");
    return this.tx(() => {
      if (!this.clock(now)) throw new Error("clock_rollback");
      const gate = this.gate();
      if (gate.freeze_id !== id) throw new Error("freeze_mismatch");
      const held = this.db.prepare("SELECT id FROM fixture_backup_window WHERE state='held'").get();
      if (held) this.invalidate(held.id, "freeze_released");
      this.db.prepare("UPDATE fixture_window_freeze SET released=1 WHERE id=?").run(id);
      this.db.prepare("UPDATE fixture_window_gate SET freeze_id=NULL WHERE id=1").run();
    });
  }
  evidence(id, freezeId, expiresAt, now) {
    if (!nonempty(id) || !nonempty(freezeId) || !Number.isSafeInteger(expiresAt)) throw new Error("invalid_evidence");
    return this.tx(() => {
      if (!this.clock(now)) throw new Error("clock_rollback");
      const gate = this.gate();
      if (gate.freeze_id !== freezeId || expiresAt <= now) throw new Error("invalid_evidence_scope_or_expiry");
      this.db.prepare("INSERT INTO fixture_window_evidence VALUES (?,?,?,1,?,0)").run(id, freezeId, gate.epoch, expiresAt);
    });
  }
  revokeEvidence(id, now) {
    return this.tx(() => {
      if (!this.clock(now)) throw new Error("clock_rollback");
      const changed = this.db.prepare("UPDATE fixture_window_evidence SET revoked=1,revision=revision+1 WHERE id=? AND revoked=0").run(id);
      if (!changed.changes) throw new Error("evidence_missing_or_revoked");
      const held = this.db.prepare("SELECT id FROM fixture_backup_window WHERE state='held' AND evidence_id=?").get(id);
      if (held) this.invalidate(held.id, "evidence_revoked");
    });
  }
  acquire({ id, owner, freezeId, evidenceId, now }) {
    if (![id, owner, freezeId, evidenceId].every(nonempty)) throw new Error("invalid_window_identity");
    return this.tx(() => {
      if (!this.clock(now)) throw new Error("clock_rollback");
      const gate = this.gate(); const proof = this.db.prepare("SELECT * FROM fixture_window_evidence WHERE id=?").get(evidenceId);
      if (gate.freeze_id !== freezeId || !proof || proof.freeze_id !== freezeId || proof.epoch !== gate.epoch || proof.revoked || proof.expires_at <= now) throw new Error("evidence_unavailable");
      this.db.prepare("INSERT INTO fixture_backup_window (id,freeze_id,epoch,owner,evidence_id,evidence_revision,state) VALUES (?,?,?,?,?,?,'held')").run(id, freezeId, gate.epoch, owner, evidenceId, proof.revision);
      this.audit(id, "acquired", `${freezeId}:${gate.epoch}`);
      return this.window(id);
    });
  }
  // Invalidity is persisted before returning an error; it cannot be retried
  // into a valid window after release, expiry, revocation or clock rollback.
  checked(id, owner, now, operation, beforeCommit = () => {}) {
    const result = this.tx(() => {
      const item = this.window(id); if (!item) return { error: "window_missing" };
      if (item.state !== "held") return { error: "window_not_held" };
      if (item.owner !== owner) return { error: "owner_mismatch" };
      if (!this.clock(now)) { this.invalidate(id, "clock_rollback"); return { error: "clock_rollback" }; }
      const gate = this.gate(); const proof = this.db.prepare("SELECT * FROM fixture_window_evidence WHERE id=?").get(item.evidence_id);
      let reason;
      if (gate.freeze_id !== item.freeze_id || gate.epoch !== item.epoch) reason = "freeze_changed";
      else if (!proof || proof.freeze_id !== item.freeze_id || proof.epoch !== item.epoch || proof.revoked || proof.revision !== item.evidence_revision) reason = "evidence_changed";
      else if (now >= proof.expires_at) reason = "evidence_expired";
      if (reason) { this.invalidate(id, reason); return { error: reason }; }
      return operation(item);
    }, beforeCommit);
    if (result.error) throw new Error(result.error);
    return result;
  }
  startStep(id, owner, step, now, beforeCommit) {
    return this.checked(id, owner, now, (item) => {
      if (item.inflight || steps[item.step_index] !== step) return { error: "step_order_or_inflight" };
      this.db.prepare("UPDATE fixture_backup_window SET inflight=? WHERE id=?").run(step, id);
      this.audit(id, "step_started", step);
      return { step, state: "inflight" };
    }, beforeCommit);
  }
  finishStep(id, owner, step, now, beforeCommit) {
    return this.checked(id, owner, now, (item) => {
      if (item.step_index > 0 && steps[item.step_index - 1] === step && !item.inflight) return { step, alreadyFinished: true };
      if (item.inflight !== step || steps[item.step_index] !== step) return { error: "step_order_or_inflight" };
      this.db.prepare("UPDATE fixture_backup_window SET step_index=step_index+1,inflight=NULL WHERE id=?").run(id);
      this.audit(id, "step_finished", step);
      return { step, alreadyFinished: false };
    }, beforeCommit);
  }
  finishWindow(id, owner, now, publish = () => {}) {
    return this.checked(id, owner, now, (item) => {
      if (item.inflight || item.step_index !== steps.length) return { error: "steps_incomplete" };
      // Only a local fixture may run this synchronous callback while the
      // SQLite write transaction prevents a concurrent fixture release.
      if (publish.constructor?.name === "AsyncFunction") throw new Error("async_publication_forbidden");
      const result = publish();
      if (result && typeof result.then === "function") throw new Error("async_publication_forbidden");
      this.db.prepare("UPDATE fixture_backup_window SET state='completed' WHERE id=?").run(id);
      this.audit(id, "completed", "fixture-only");
      return { state: "completed", remoteExecutionAvailable: false };
    });
  }
  // On restart the model cannot prove an external step finished; a held
  // window is invalidated even if no step was recorded as in flight.
  restart() {
    return this.tx(() => {
      const held = this.db.prepare("SELECT id FROM fixture_backup_window WHERE state='held'").get();
      if (held) this.invalidate(held.id, "process_interrupted");
    });
  }
}
