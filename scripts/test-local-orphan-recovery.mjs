/* global process, setTimeout, structuredClone */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
import { createLocalOrphanFixture, reopenLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";
import { observeLocalOrphan, verifyLocalOrphanObservation } from "./local-orphan-review-fixture.mjs";

function setup({ invalidated = true, stopped = true } = {}) {
  const supervisor = { stopped }; const { root, capability, fixture } = createLocalOrphanFixture(() => supervisor.stopped);
  const model = new LocalBackupWindowFixture(fixture.db); model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
  const attempt = fixture.plan("window"); mkdirSync(attempt.output); mkdirSync(path.join(attempt.output, ".fixture-staging")); writeFileSync(path.join(attempt.output, ".fixture-staging", "counts.json"), "fixture"); fixture.attest(attempt.id, attempt.nonce);
  if (invalidated) model.restart();
  const dispose = () => { fixture.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, capability, fixture, model, attempt, supervisor, dispose };
}
function audit(fixture, id, action) { return fixture.db.prepare("SELECT COUNT(*) AS n FROM fixture_orphan_audit WHERE attempt_id=? AND action=?").get(id, action).n; }

test("owned invalidated orphan cleans once and repeated recovery is idempotent", () => {
  const x = setup(); try {
    assert.deepEqual(x.fixture.recover(x.attempt.id), { state: "cleaned", alreadyApplied: false, remoteExecutionAvailable: false });
    assert.equal(existsSync(x.attempt.output), false);
    assert.deepEqual(x.fixture.recover(x.attempt.id), { state: "cleaned", alreadyApplied: true, remoteExecutionAvailable: false });
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_started"), 1); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 1);
    assert.throws(() => x.fixture.db.exec("DELETE FROM fixture_orphan_audit"), /audit_immutable/u);
  } finally { x.dispose(); }
});

test("unknown, malformed and path traversal identities cannot be cleaned", () => {
  const x = setup(); try {
    assert.throws(() => x.fixture.recover("../elsewhere"), /invalid_attempt_id/u);
    assert.throws(() => x.fixture.recover(randomUUID()), /attempt_not_attested/u);
    const planned = x.fixture.plan("window"); assert.throws(() => x.fixture.recover(planned.id), /attempt_not_attested/u);
    assert.equal(existsSync(x.attempt.output), true);
  } finally { x.dispose(); }
});

test("a live supervisor and a held window independently block cleanup", () => {
  const x = setup({ invalidated: false, stopped: false }); try {
    assert.throws(() => x.fixture.recover(x.attempt.id), /supervisor_not_stopped/u);
    x.supervisor.stopped = true; assert.throws(() => x.fixture.recover(x.attempt.id), /window_still_held/u);
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_started"), 0); assert.equal(existsSync(x.attempt.output), true);
  } finally { x.dispose(); }
});

test("completed window is preserved and preservation audit is idempotent", () => {
  const x = setup({ invalidated: false }); try {
    let now = 4; for (const step of ["d1_export", "media_inventory", "media_download", "verify", "finalize"]) { x.model.startStep("window", "owner", step, now++); x.model.finishStep("window", "owner", step, now++); }
    x.model.finishWindow("window", "owner", now);
    assert.equal(x.fixture.recover(x.attempt.id).state, "preserved"); assert.equal(x.fixture.recover(x.attempt.id).alreadyApplied, true);
    assert.equal(audit(x.fixture, x.attempt.id, "preserved"), 1); assert.equal(existsSync(x.attempt.output), true);
  } finally { x.dispose(); }
});

test("unknown contents and marker tampering are rejected without deleting files", () => {
  const x = setup(); try {
    const unexpected = path.join(x.attempt.output, ".fixture-staging", "unknown.bin"); writeFileSync(unexpected, "keep");
    assert.throws(() => x.fixture.recover(x.attempt.id), /unrecognized_fixture_entry/u); assert.equal(readFileSync(unexpected, "utf8"), "keep"); unlinkSync(unexpected);
    const marker = path.join(x.attempt.output, ".fixture-owner.json"); const saved = readFileSync(marker, "utf8"); const parsed = JSON.parse(saved); parsed.nonce = "forged"; writeFileSync(marker, JSON.stringify(parsed));
    assert.throws(() => x.fixture.recover(x.attempt.id), /owner_marker_mismatch/u); assert.equal(x.fixture.record(x.attempt.id).state, "owned");
  } finally { x.dispose(); }
});

test("symlinks, unknown hard links and replaced attempt inode fail closed", () => {
  const x = setup(); const external = mkdtempSync(path.join(tmpdir(), "cg-orphan-outside-"));
  try {
    const secret = path.join(external, "keep"); writeFileSync(secret, "untouched");
    const link = path.join(x.attempt.output, ".fixture-staging", "package"); symlinkSync(external, link);
    assert.throws(() => x.fixture.recover(x.attempt.id), /fixture_symlink_forbidden/u); unlinkSync(link);
    const hard = path.join(x.attempt.output, ".fixture-staging", "fixture-complete.json"); linkSync(secret, hard);
    assert.throws(() => x.fixture.recover(x.attempt.id), /unrecognized_fixture_entry/u); unlinkSync(hard);
    const old = path.join(x.root, "displaced"); renameSync(x.attempt.output, old); mkdirSync(x.attempt.output);
    assert.throws(() => x.fixture.recover(x.attempt.id), /attempt_identity_changed/u);
    assert.equal(readFileSync(secret, "utf8"), "untouched");
  } finally { x.dispose(); rmSync(external, { recursive: true, force: true }); }
});

test("marker symlink and reappearance after successful cleanup are refused", () => {
  const x = setup(); const external = mkdtempSync(path.join(tmpdir(), "cg-orphan-marker-"));
  try {
    const marker = path.join(x.attempt.output, ".fixture-owner.json"); const saved = readFileSync(marker); unlinkSync(marker); const target = path.join(external, "marker"); writeFileSync(target, saved); symlinkSync(target, marker);
    assert.throws(() => x.fixture.recover(x.attempt.id), /owner_marker_invalid/u); unlinkSync(marker); writeFileSync(marker, saved);
    x.fixture.recover(x.attempt.id); symlinkSync(path.join(external, "missing"), x.attempt.output);
    assert.throws(() => x.fixture.recover(x.attempt.id), /cleaned_path_reappeared/u);
  } finally { x.dispose(); rmSync(external, { recursive: true, force: true }); }
});

test("a change between checks is detected and failure stays auditable", () => {
  const x = setup(); try {
    assert.throws(() => x.fixture.recover(x.attempt.id, { beforeRemove: () => writeFileSync(path.join(x.attempt.output, "surprise"), "keep") }), /unrecognized_fixture_entry/u);
    assert.equal(readFileSync(path.join(x.attempt.output, "surprise"), "utf8"), "keep");
    assert.equal(x.fixture.record(x.attempt.id).state, "failed"); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_failed"), 1);
  } finally { x.dispose(); }
});

test("replacement of the attempt directory during anchored cleanup never follows the replacement", () => {
  const x = setup(); const outside = mkdtempSync(path.join(tmpdir(), "cg-orphan-swap-"));
  try {
    const keep = path.join(outside, "counts.json"); writeFileSync(keep, "keep");
    assert.throws(() => x.fixture.recover(x.attempt.id, { beforeEntry: () => {
      renameSync(x.attempt.output, path.join(x.root, "displaced")); symlinkSync(outside, x.attempt.output);
    } }), /fixture_directory_changed/u);
    assert.equal(readFileSync(keep, "utf8"), "keep"); assert.equal(x.fixture.record(x.attempt.id).state, "failed");
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
  } finally { x.dispose(); rmSync(outside, { recursive: true, force: true }); }
});

test("replaced leaf is refused and a no-op remover cannot claim cleanup completed", () => {
  const x = setup(); try {
    const target = path.join(x.attempt.output, ".fixture-staging", "counts.json");
    assert.throws(() => x.fixture.recover(x.attempt.id, { beforeEntry: (entry) => {
      if (entry.endsWith("counts.json")) { unlinkSync(target); symlinkSync("/dev/null", target); }
    } }), /fixture_entry_changed/u);
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
    unlinkSync(target); writeFileSync(target, "fixture");
    assert.throws(() => x.fixture.recover(x.attempt.id, { remove: () => {} }), /cleanup_output_remains/u);
    assert.equal(x.fixture.record(x.attempt.id).state, "failed"); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
    assert.equal(x.fixture.recover(x.attempt.id).state, "cleaned");
  } finally { x.dispose(); }
});

test("an attempt moved away during a failed cleanup cannot be mistaken for completed deletion", () => {
  const x = setup(); try {
    assert.throws(() => x.fixture.recover(x.attempt.id, { beforeEntry: () => {
      renameSync(x.attempt.output, path.join(x.root, "displaced"));
    } }), /ENOENT/u);
    assert.equal(x.fixture.record(x.attempt.id).state, "failed");
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_failed"), 1); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
    assert.throws(() => x.fixture.recover(x.attempt.id), /attempt_missing_without_cleanup_intent/u);
    assert.equal(existsSync(path.join(x.root, "displaced", ".fixture-owner.json")), true);
  } finally { x.dispose(); }
});

test("failed removal is auditable and can be retried without duplicate completion", () => {
  const x = setup(); try {
    assert.throws(() => x.fixture.recover(x.attempt.id, { remove: () => { throw new Error("injected_remove_failure"); } }), /injected_remove_failure/u);
    assert.equal(x.fixture.record(x.attempt.id).state, "failed"); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_failed"), 1);
    assert.equal(x.fixture.recover(x.attempt.id).state, "cleaned"); assert.equal(x.fixture.recover(x.attempt.id).alreadyApplied, true);
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 1);
  } finally { x.dispose(); }
});

test("partial deletion losing ownership marker requires manual review", () => {
  const x = setup(); try {
    assert.throws(() => x.fixture.recover(x.attempt.id, { remove: (dir) => { unlinkSync(path.join(dir, ".fixture-owner.json")); throw new Error("partial_removal"); } }), /partial_removal/u);
    assert.throws(() => x.fixture.recover(x.attempt.id), /ENOENT/u); assert.equal(existsSync(x.attempt.output), true);
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
  } finally { x.dispose(); }
});

test("read-only observation of a missing marker is stable, verifiable and cannot authorize cleanup", () => {
  const x = setup(); try {
    unlinkSync(path.join(x.attempt.output, ".fixture-owner.json"));
    const total = x.fixture.db.prepare("SELECT COUNT(*) AS n FROM fixture_orphan_audit").get().n;
    x.fixture.db.exec("PRAGMA query_only=ON");
    const report = observeLocalOrphan(x.fixture, x.attempt.id);
    assert.equal(report.evidence.marker, "missing"); assert.equal(report.evidence.outcome, "review_required");
    assert.equal(report.evidence.remoteExecutionAvailable, false); assert.deepEqual(observeLocalOrphan(x.fixture, x.attempt.id), report);
    assert.equal(verifyLocalOrphanObservation(x.fixture, report), true);
    const forged = structuredClone(report); forged.evidence.marker = "matches"; assert.equal(verifyLocalOrphanObservation(x.fixture, forged), false);
    assert.equal(x.fixture.db.prepare("SELECT COUNT(*) AS n FROM fixture_orphan_audit").get().n, total);
    assert.equal(x.fixture.record(x.attempt.id).state, "owned"); assert.equal(existsSync(x.attempt.output), true);
    x.fixture.db.exec("PRAGMA query_only=OFF"); assert.throws(() => x.fixture.recover(x.attempt.id), /ENOENT/u);
    const resumed = reopenLocalOrphanFixture(x.root, x.capability, () => true);
    try { assert.equal(verifyLocalOrphanObservation(resumed, report), true); } finally { resumed.close(); }
  } finally { x.fixture.db.exec("PRAGMA query_only=OFF"); x.dispose(); }
});

test("observation refuses traversal, ignores symlink targets, and detects stale evidence", () => {
  const x = setup(); const outside = mkdtempSync(path.join(tmpdir(), "cg-review-outside-"));
  try {
    assert.throws(() => observeLocalOrphan(x.fixture, "../escape"), /invalid_attempt_id/u);
    assert.throws(() => observeLocalOrphan(x.fixture, randomUUID()), /attempt_not_attested/u);
    const before = observeLocalOrphan(x.fixture, x.attempt.id); assert.equal(before.evidence.marker, "matches");
    renameSync(x.attempt.output, path.join(x.root, "displaced"));
    writeFileSync(path.join(outside, "keep"), "untouched"); symlinkSync(outside, x.attempt.output);
    assert.equal(verifyLocalOrphanObservation(x.fixture, before), false);
    const changed = observeLocalOrphan(x.fixture, x.attempt.id);
    assert.equal(changed.evidence.observedDirectory.type, "symlink"); assert.equal(changed.evidence.marker, "not_inspected");
    assert.equal(readFileSync(path.join(outside, "keep"), "utf8"), "untouched");
  } finally { x.dispose(); rmSync(outside, { recursive: true, force: true }); }
});

test("review does not follow a marker symlink and detects subsequent audit changes", () => {
  const x = setup(); const outside = mkdtempSync(path.join(tmpdir(), "cg-review-marker-"));
  try {
    const marker = path.join(x.attempt.output, ".fixture-owner.json"); unlinkSync(marker);
    const keep = path.join(outside, "keep"); writeFileSync(keep, "outside"); symlinkSync(keep, marker);
    const report = observeLocalOrphan(x.fixture, x.attempt.id); assert.equal(report.evidence.marker, "invalid");
    assert.equal(readFileSync(keep, "utf8"), "outside"); assert.equal(verifyLocalOrphanObservation(x.fixture, report), true);
    x.fixture.tx(() => x.fixture.audit(x.attempt.id, "fixture_test_event"));
    assert.equal(verifyLocalOrphanObservation(x.fixture, report), false);
    assert.equal(observeLocalOrphan(x.fixture, x.attempt.id).evidence.audit.at(-1).action, "fixture_test_event");
  } finally { x.dispose(); rmSync(outside, { recursive: true, force: true }); }
});

test("audit failure before cleanup leaves files and state unchanged", () => {
  const x = setup(); try {
    x.fixture.db.exec("CREATE TRIGGER inject_start_failure BEFORE INSERT ON fixture_orphan_audit WHEN NEW.action='cleanup_started' BEGIN SELECT RAISE(ABORT,'injected_audit_failure'); END;");
    assert.throws(() => x.fixture.recover(x.attempt.id), /injected_audit_failure/u);
    assert.equal(existsSync(x.attempt.output), true); assert.equal(x.fixture.record(x.attempt.id).state, "owned");
    x.fixture.db.exec("DROP TRIGGER inject_start_failure"); assert.equal(x.fixture.recover(x.attempt.id).state, "cleaned");
  } finally { x.dispose(); }
});

test("failure to audit a removal error preserves durable intent for retry", () => {
  const x = setup(); try {
    x.fixture.db.exec("CREATE TRIGGER inject_failure_audit BEFORE INSERT ON fixture_orphan_audit WHEN NEW.action='cleanup_failed' BEGIN SELECT RAISE(ABORT,'injected_failure_audit'); END;");
    assert.throws(() => x.fixture.recover(x.attempt.id, { remove: () => { throw new Error("injected_remove_failure"); } }), /injected_failure_audit/u);
    assert.equal(existsSync(x.attempt.output), true); assert.equal(x.fixture.record(x.attempt.id).state, "cleaning");
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_started"), 1); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_failed"), 0);
    x.fixture.db.exec("DROP TRIGGER inject_failure_audit"); assert.equal(x.fixture.recover(x.attempt.id).state, "cleaned");
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 1);
  } finally { x.dispose(); }
});

test("audit failure after deletion leaves an ambiguous intent for review", () => {
  const x = setup(); try {
    x.fixture.db.exec("CREATE TRIGGER inject_finish_failure BEFORE INSERT ON fixture_orphan_audit WHEN NEW.action='cleanup_completed' BEGIN SELECT RAISE(ABORT,'injected_audit_failure'); END;");
    assert.throws(() => x.fixture.recover(x.attempt.id), /injected_audit_failure/u);
    assert.equal(existsSync(x.attempt.output), false); assert.equal(x.fixture.record(x.attempt.id).state, "cleaning");
    x.fixture.db.exec("DROP TRIGGER inject_finish_failure"); assert.throws(() => x.fixture.recover(x.attempt.id), /attempt_missing_requires_review/u);
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
  } finally { x.dispose(); }
});

test("reopen needs the original capability and private test root", () => {
  const x = setup(); try {
    assert.throws(() => reopenLocalOrphanFixture(x.root, "wrong", () => true), /fixture_capability_invalid/u);
    assert.throws(() => reopenLocalOrphanFixture(tmpdir(), x.capability, () => true), /fixture_root_invalid/u);
    const reopened = reopenLocalOrphanFixture(x.root, x.capability, () => true); assert.equal(reopened.record(x.attempt.id).state, "owned"); reopened.close();
  } finally { x.dispose(); }
});

test("SIGKILL after physical removal preserves ambiguous intent and restart requires review", async () => {
  const x = setup(); const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-cleanup-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    child.send({ root: x.root, capability: x.capability, attemptId: x.attempt.id });
    let ready = false; for (let i = 0; i < 300; i += 1) { if (stdout.includes("removed_before_audit\n")) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.equal(ready, true, `cleanup checkpoint not reached: ${stderr}`); child.kill("SIGKILL"); assert.equal((await closed).signal, "SIGKILL");
    assert.equal(existsSync(x.attempt.output), false); assert.equal(x.fixture.record(x.attempt.id).state, "cleaning");
    const resumed = reopenLocalOrphanFixture(x.root, x.capability, () => true);
    try { assert.throws(() => resumed.recover(x.attempt.id), /attempt_missing_requires_review/u); assert.equal(observeLocalOrphan(resumed, x.attempt.id).evidence.observedDirectory, null); assert.equal(audit(resumed, x.attempt.id, "cleanup_completed"), 0); }
    finally { resumed.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } x.dispose(); }
});

for (const checkpoint of [".fixture-staging/counts.json", ".fixture-owner.json"]) {
  test(`SIGKILL during anchored deletion at ${checkpoint} leaves a conservative restart state`, async () => {
    const x = setup(); const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-cleanup-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
      child.send({ root: x.root, capability: x.capability, attemptId: x.attempt.id, checkpoint });
      let ready = false; for (let i = 0; i < 300; i += 1) { if (stdout.includes(`entry:${checkpoint}\n`)) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      assert.equal(ready, true, `cleanup checkpoint not reached: ${stderr}`); child.kill("SIGKILL"); assert.equal((await closed).signal, "SIGKILL");
      assert.equal(x.fixture.record(x.attempt.id).state, "cleaning"); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
      const resumed = reopenLocalOrphanFixture(x.root, x.capability, () => true);
      try {
        if (checkpoint === ".fixture-owner.json") { assert.throws(() => resumed.recover(x.attempt.id), /ENOENT/u); assert.equal(existsSync(x.attempt.output), true); }
        else { assert.equal(resumed.recover(x.attempt.id).state, "cleaned"); assert.equal(resumed.recover(x.attempt.id).alreadyApplied, true); assert.equal(audit(resumed, x.attempt.id, "cleanup_completed"), 1); }
      } finally { resumed.close(); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } x.dispose(); }
  });
}

test("another process replacing the attempt while cleanup is paused cannot redirect deletion", async () => {
  const x = setup(); const outside = mkdtempSync(path.join(tmpdir(), "cg-orphan-concurrent-"));
  const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-cleanup-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const keep = path.join(outside, "keep"); writeFileSync(keep, "outside");
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    child.send({ root: x.root, capability: x.capability, attemptId: x.attempt.id, checkpoint: "before:.fixture-staging/counts.json" });
    let ready = false; for (let i = 0; i < 300; i += 1) { if (stdout.includes("before:.fixture-staging/counts.json\n")) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.equal(ready, true, `cleanup checkpoint not reached: ${stderr}`);
    renameSync(x.attempt.output, path.join(x.root, "displaced")); symlinkSync(outside, x.attempt.output);
    const result = await closed; assert.notEqual(result.code, 0); assert.match(stderr, /fixture_directory_changed/u);
    assert.equal(readFileSync(keep, "utf8"), "outside"); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 0);
    assert.equal(x.fixture.record(x.attempt.id).state, "failed");
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } x.dispose(); rmSync(outside, { recursive: true, force: true }); }
});

test("move followed by SIGKILL is ambiguous and read-only review never records successful cleanup", async () => {
  const x = setup(); const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-cleanup-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    child.send({ root: x.root, capability: x.capability, attemptId: x.attempt.id, checkpoint: "before:.fixture-staging/counts.json" });
    let ready = false; for (let i = 0; i < 300; i += 1) { if (stdout.includes("before:.fixture-staging/counts.json\n")) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.equal(ready, true, `cleanup checkpoint not reached: ${stderr}`);
    const displaced = path.join(x.root, "displaced"); renameSync(x.attempt.output, displaced);
    child.kill("SIGKILL"); assert.equal((await closed).signal, "SIGKILL");
    const resumed = reopenLocalOrphanFixture(x.root, x.capability, () => true);
    try {
      assert.throws(() => resumed.recover(x.attempt.id), /attempt_missing_requires_review/u);
      const report = observeLocalOrphan(resumed, x.attempt.id);
      assert.equal(report.evidence.recordedState, "cleaning"); assert.equal(report.evidence.observedDirectory, null); assert.equal(report.evidence.marker, "not_inspected");
      assert.equal(verifyLocalOrphanObservation(resumed, report), true); assert.equal(audit(resumed, x.attempt.id, "cleanup_completed"), 0);
      assert.equal(existsSync(path.join(displaced, ".fixture-owner.json")), true);
    } finally { resumed.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } x.dispose(); }
});

test("competing recovery processes serialize and produce one completion audit", async () => {
  const x = setup();
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, [path.resolve("scripts/local-orphan-race-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  const channels = children.map((child) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const ready = new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code, signal) => reject(new Error(`child exited before ready: ${code ?? signal}`))); });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { ready, closed };
  });
  try {
    children.forEach((child) => child.send({ kind: "init", root: x.root, capability: x.capability }));
    await Promise.all(channels.map((channel) => channel.ready)); children.forEach((child) => child.send({ kind: "go", attemptId: x.attempt.id }));
    const results = await Promise.all(channels.map((channel) => channel.closed));
    assert.deepEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));
    const outputs = results.map((result) => JSON.parse(result.stdout));
    assert.deepEqual(outputs.map((value) => value.alreadyApplied).sort(), [false, true]);
    assert.equal(audit(x.fixture, x.attempt.id, "cleanup_started"), 1); assert.equal(audit(x.fixture, x.attempt.id, "cleanup_completed"), 1);
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await Promise.all(channels.map((channel) => channel.closed)); x.dispose(); }
});

for (const checkpoint of ["verify", "after_publish"]) {
  test(`real mock subprocess SIGKILL at ${checkpoint}: owned orphan is cleaned or completed output preserved`, async () => {
    const supervisor = { stopped: false }; const { root, capability, fixture } = createLocalOrphanFixture(() => supervisor.stopped);
    const model = new LocalBackupWindowFixture(fixture.db); model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
    const attempt = fixture.plan("window");
    const child = spawn(process.execPath, [path.resolve("scripts/local-windowed-mock-child.mjs"), path.join(root, "fixture.sqlite"), attempt.output, checkpoint], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      let ready = false; for (let i = 0; i < 400; i += 1) { if (stdout.includes(`checkpoint:${checkpoint}\n`)) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      assert.equal(ready, true, `mock checkpoint not reached: ${stderr}`); fixture.attest(attempt.id, attempt.nonce);
      assert.throws(() => fixture.recover(attempt.id), /supervisor_not_stopped/u);
      child.kill("SIGKILL"); assert.equal((await closed).signal, "SIGKILL"); supervisor.stopped = true; model.restart();
      const result = fixture.recover(attempt.id);
      if (checkpoint === "verify") { assert.equal(result.state, "cleaned"); assert.equal(existsSync(attempt.output), false); assert.equal(audit(fixture, attempt.id, "cleanup_completed"), 1); }
      else { assert.equal(result.state, "preserved"); assert.equal(existsSync(path.join(attempt.output, "complete", "fixture-complete.json")), true); assert.equal(audit(fixture, attempt.id, "preserved"), 1); }
      const reopened = reopenLocalOrphanFixture(root, capability, () => true); try { assert.equal(reopened.recover(attempt.id).alreadyApplied, true); } finally { reopened.close(); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } fixture.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
