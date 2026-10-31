/* global Buffer */
// Read-only observation of one existing local fixture attempt. Never a cleanup,
// approval, authentication or proof that an absent directory was deleted.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stamp = (s) => ({ dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), nlink: String(s.nlink), size: String(s.size), ctimeNs: String(s.ctimeNs), mtimeNs: String(s.mtimeNs) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function statOrNull(filename) {
  try { return lstatSync(filename, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function entry(s) { return !s ? null : { type: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other", ...stamp(s) }; }

// Only the registered attempt and its fixed marker are inspected; no scanning
// for moved paths, arbitrary paths, file contents, or secrets is exposed.
export function observeLocalOrphan(fixture, id) {
  fixture.verifyRoot(); const rootFd = openSync(fixture.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = [rootFd];
  try {
    const rootStat = fstatSync(rootFd, { bigint: true });
    if (String(rootStat.dev) !== fixture.rootId.dev || String(rootStat.ino) !== fixture.rootId.ino) throw new Error("review_root_changed");
    const target = `/proc/self/fd/${rootFd}/attempt-${id}`;
    // record() validates UUID before the derived path is used.
    fixture.db.exec("BEGIN");
    try {
      const row = fixture.record(id); if (!row) throw new Error("attempt_not_attested");
      const window = fixture.db.prepare("SELECT state FROM fixture_backup_window WHERE id=?").get(row.window_id);
      const audit = fixture.db.prepare("SELECT id, action FROM fixture_orphan_audit WHERE attempt_id=? ORDER BY id LIMIT 101").all(id);
      if (audit.length > 100) throw new Error("review_audit_limit");
      const before = statOrNull(target); const observed = entry(before); let marker = "not_inspected"; let markerBefore = null; let markerPath = null;
      if (before?.isDirectory() && !before.isSymbolicLink() && String(before.dev) === row.device && String(before.ino) === row.inode) {
        const attemptFd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); opened.push(attemptFd);
        if (!same(entry(before), entry(fstatSync(attemptFd, { bigint: true })))) throw new Error("review_snapshot_changed");
        markerPath = `/proc/self/fd/${attemptFd}/.fixture-owner.json`; markerBefore = statOrNull(markerPath);
        if (!markerBefore) marker = "missing";
        else if (!markerBefore.isFile() || markerBefore.isSymbolicLink() || markerBefore.nlink !== 1n || markerBefore.size > 4096n) marker = "invalid";
        else {
          const markerFd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW); opened.push(markerFd);
          if (!same(entry(markerBefore), entry(fstatSync(markerFd, { bigint: true })))) throw new Error("review_snapshot_changed");
          try {
            const buffer = Buffer.alloc(4097); const size = readSync(markerFd, buffer, 0, buffer.length, 0);
            if (size > 4096) throw new Error("review_snapshot_changed");
            const value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
            marker = value && typeof value === "object" && value.fixtureOnly === true && value.attemptId === id && value.windowId === row.window_id && value.dev === row.device && value.ino === row.inode && typeof value.nonce === "string" && digest(value.nonce) === row.nonce_hash ? "matches" : "mismatch";
          } catch (error) { if (error instanceof SyntaxError) marker = "invalid"; else throw error; }
        }
      }
      fixture.verifyRoot();
      if (!same(observed, entry(statOrNull(target))) || (markerPath && !same(entry(markerBefore), entry(statOrNull(markerPath))))) throw new Error("review_snapshot_changed");
      const evidence = { version: 1, fixtureOnly: true, attemptId: id, recordedState: row.state, windowState: window?.state ?? "missing", expectedDirectory: row.device && row.inode ? { dev: row.device, ino: row.inode } : null, observedDirectory: observed, marker, audit: audit.map((item) => ({ id: item.id, action: item.action })), outcome: "review_required", remoteExecutionAvailable: false };
      fixture.db.exec("COMMIT");
      return { evidence, sha256: digest(JSON.stringify(evidence)) };
    } catch (error) { fixture.db.exec("ROLLBACK"); throw error; }
  } finally { while (opened.length) closeSync(opened.pop()); }
}

// Comparison is to a fresh observation, not a signature or authentication.
export function verifyLocalOrphanObservation(fixture, report) {
  if (!report || typeof report !== "object" || !report.evidence || typeof report.sha256 !== "string" || digest(JSON.stringify(report.evidence)) !== report.sha256) return false;
  const current = observeLocalOrphan(fixture, report.evidence.attemptId);
  return current.sha256 === report.sha256 && JSON.stringify(current.evidence) === JSON.stringify(report.evidence);
}
