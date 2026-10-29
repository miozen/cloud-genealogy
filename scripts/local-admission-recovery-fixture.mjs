import { createHash, randomUUID } from "node:crypto";

// Isolated SQLite prototype only; not an application migration or recovery API.
export function createRecoveryFixtureSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS local_fixture_admission_recovery (
    request_id TEXT PRIMARY KEY, admission_id TEXT NOT NULL UNIQUE REFERENCES backup_write_admission(id),
    freeze_id TEXT NOT NULL REFERENCES backup_write_freeze(id), admission_epoch INTEGER NOT NULL,
    freeze_epoch INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES account(id),
    reviewer_id TEXT NOT NULL REFERENCES account(id), reason TEXT NOT NULL, evidence_json TEXT NOT NULL,
    evidence_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state = 'recovered'), recovered_at TEXT NOT NULL,
    CHECK(actor_id <> reviewer_id)
  );
  CREATE TRIGGER IF NOT EXISTS local_fixture_recovery_immutable_update BEFORE UPDATE ON local_fixture_admission_recovery BEGIN SELECT RAISE(ABORT, 'recovery_record_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS local_fixture_recovery_immutable_delete BEFORE DELETE ON local_fixture_admission_recovery BEGIN SELECT RAISE(ABORT, 'recovery_record_immutable'); END;`);
}

export function recoverLocalAdmission(database, { requestId, admissionId, freezeId, actorId, reviewerId, evidence, stopped, reason, injectAuditFailure = false, onCheckpoint = () => {} }) {
  if (!stopped()) throw new Error("worker_group_still_running");
  if (!reason?.trim()) throw new Error("recovery_reason_required");
  if (!requestId || !actorId || !reviewerId || actorId === reviewerId) throw new Error("two_distinct_approvers_required");
  if (!evidence || evidence.kind !== "isolated_process_group_stopped" || !evidence.supervisorId || !Number.isSafeInteger(evidence.processGroupId) || evidence.processGroupId < 1 || !evidence.observedAt) throw new Error("recovery_evidence_invalid");
  const evidenceJson = JSON.stringify({ kind: evidence.kind, supervisorId: evidence.supervisorId, processGroupId: evidence.processGroupId, observedAt: evidence.observedAt });
  const evidenceHash = createHash("sha256").update(evidenceJson).digest("hex");
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(`SELECT admission.id, admission.epoch, current.epoch AS current_epoch
      FROM backup_write_admission AS admission
      JOIN backup_write_epoch AS current ON current.id = 1
      JOIN backup_write_freeze AS freeze ON freeze.id = ? AND freeze.released_at IS NULL
      WHERE admission.id = ? AND admission.completed_at IS NULL`).get(freezeId, admissionId);
    if (!row) throw new Error("active_freeze_or_open_admission_missing");
    if (row.epoch >= row.current_epoch) throw new Error("admission_not_fenced");
    if (!stopped()) throw new Error("worker_group_still_running");
    const actors = database.prepare(`SELECT COUNT(DISTINCT account.id) AS n FROM account
      JOIN account_role ON account_role.account_id = account.id
      JOIN role ON role.id = account_role.role_id AND role.name = 'admin'
      WHERE account.status = 'active' AND account.id IN (?, ?)`).get(actorId, reviewerId);
    if (actors.n !== 2) throw new Error("approver_not_active_admin");
    const existing = database.prepare("SELECT * FROM local_fixture_admission_recovery WHERE request_id = ? OR admission_id = ?").get(requestId, admissionId);
    if (existing) {
      if (existing.request_id !== requestId || existing.admission_id !== admissionId || existing.freeze_id !== freezeId || existing.actor_id !== actorId || existing.reviewer_id !== reviewerId || existing.reason !== reason || existing.evidence_sha256 !== evidenceHash || existing.admission_epoch !== row.epoch || existing.freeze_epoch !== row.current_epoch) throw new Error("recovery_request_conflict");
      database.exec("COMMIT");
      return { state: "recovered", alreadyApplied: true };
    }
    const timestamp = new Date().toISOString();
    database.prepare(`INSERT INTO local_fixture_admission_recovery (request_id, admission_id, freeze_id, admission_epoch, freeze_epoch, actor_id, reviewer_id, reason, evidence_json, evidence_sha256, state, recovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recovered', ?)`)
      .run(requestId, admissionId, freezeId, row.epoch, row.current_epoch, actorId, reviewerId, reason, evidenceJson, evidenceHash, timestamp);
    database.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), actorId, "backup.local_fixture_admission_recovered", "backup_write_admission", admissionId,
        JSON.stringify({ requestId, freezeId, reviewerId, reason, previousEpoch: row.epoch, currentEpoch: row.current_epoch, evidenceSha256: evidenceHash, fixtureOnly: true }), timestamp);
    if (injectAuditFailure) throw new Error("injected_recovery_failure");
    onCheckpoint("before_commit");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  onCheckpoint("after_commit");
  return { state: "recovered", alreadyApplied: false };
}
