import { randomUUID } from "node:crypto";

// Test fixture only. The caller owns the entire isolated Worker process group
// and can prove that it has stopped. This is not a Cloudflare recovery API.
export function recoverLocalAdmission(database, { admissionId, freezeId, actorId, stopped, reason, injectAuditFailure = false }) {
  if (!stopped()) throw new Error("worker_group_still_running");
  if (!reason?.trim()) throw new Error("recovery_reason_required");
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(`SELECT admission.id, admission.epoch, current.epoch AS current_epoch
      FROM backup_write_admission AS admission
      JOIN backup_write_epoch AS current ON current.id = 1
      JOIN backup_write_freeze AS freeze ON freeze.id = ? AND freeze.released_at IS NULL
      WHERE admission.id = ? AND admission.completed_at IS NULL`).get(freezeId, admissionId);
    if (!row) throw new Error("active_freeze_or_open_admission_missing");
    if (row.epoch >= row.current_epoch) throw new Error("admission_not_fenced");
    // Recheck under the transaction: process supervision is external to D1.
    if (!stopped()) throw new Error("worker_group_still_running");
    const timestamp = new Date().toISOString();
    const changed = database.prepare("UPDATE backup_write_admission SET completed_at = ? WHERE id = ? AND completed_at IS NULL").run(timestamp, admissionId);
    if (changed.changes !== 1) throw new Error("admission_changed");
    database.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), actorId, "backup.local_fixture_admission_recovered", "backup_write_admission", admissionId,
        JSON.stringify({ freezeId, reason, previousEpoch: row.epoch, currentEpoch: row.current_epoch, fixtureOnly: true }), timestamp);
    if (injectAuditFailure) throw new Error("injected_recovery_failure");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
