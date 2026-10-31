/* global process, setTimeout */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";

const steps = ["d1_export", "media_inventory", "media_download", "verify", "finalize"];
function setup() {
  const db = new DatabaseSync(":memory:");
  const m = new LocalBackupWindowFixture(db);
  m.freeze("freeze", 1); m.evidence("evidence", "freeze", 100, 2);
  m.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
  return { db, m };
}
function assertInvalid(m, reason) {
  assert.equal(m.window("window").state, "invalidated");
  assert.equal(m.window("window").failure, reason);
  assert.throws(() => m.finishWindow("window", "owner", 99), /window_not_held/u);
}

test("ordered steps complete only in the same synthetic window; remote stays disabled", () => {
  const { db, m } = setup();
  let now = 4;
  for (const step of steps) {
    assert.equal(m.startStep("window", "owner", step, now++).state, "inflight");
    assert.equal(m.finishStep("window", "owner", step, now++).alreadyFinished, false);
  }
  assert.deepEqual(m.finishWindow("window", "owner", now), { state: "completed", remoteExecutionAvailable: false });
  assert.equal(m.window("window").step_index, 5);
  assert.throws(() => m.finishWindow("window", "owner", now), /window_not_held/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action='completed'").get().n, 1);
  db.close();
});

test("release invalidates a held window and keeps invalidation in audit", () => {
  const { db, m } = setup(); m.startStep("window", "owner", steps[0], 4); m.release("freeze", 5);
  assertInvalid(m, "freeze_released");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action='invalidated'").get().n, 1);
  assert.throws(() => m.finishStep("window", "owner", steps[0], 6), /window_not_held/u); db.close();
});

for (const [index, interruptedStep] of steps.entries()) {
  test(`release during ${interruptedStep} prevents all later stages`, () => {
    const { db, m } = setup(); let now = 4;
    for (const step of steps.slice(0, index)) { m.startStep("window", "owner", step, now++); m.finishStep("window", "owner", step, now++); }
    m.startStep("window", "owner", interruptedStep, now++);
    m.release("freeze", now++);
    assert.throws(() => m.finishStep("window", "owner", interruptedStep, now), /window_not_held/u);
    assert.equal(m.window("window").step_index, index);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action='completed'").get().n, 0);
    db.close();
  });
}

test("release and refreeze cannot revive old epoch even with new evidence", () => {
  const { db, m } = setup(); m.release("freeze", 4); assert.equal(m.freeze("next-freeze", 5), 2);
  m.evidence("next-evidence", "next-freeze", 100, 6); assertInvalid(m, "freeze_released");
  assert.throws(() => m.acquire({ id: "old", owner: "owner", freezeId: "next-freeze", evidenceId: "evidence", now: 7 }), /evidence_unavailable/u);
  assert.equal(m.acquire({ id: "new", owner: "owner", freezeId: "next-freeze", evidenceId: "next-evidence", now: 8 }).epoch, 2); db.close();
});

test("same freeze identifier cannot be reused after release", () => {
  const { db, m } = setup(); m.release("freeze", 4);
  assert.throws(() => m.freeze("freeze", 5), /UNIQUE constraint failed/u); assert.equal(m.gate().epoch, 1); db.close();
});

test("evidence expiration at the exact boundary invalidates the window", () => {
  const { db, m } = setup(); assert.throws(() => m.startStep("window", "owner", steps[0], 100), /evidence_expired/u); assertInvalid(m, "evidence_expired"); db.close();
});

test("evidence expiring during an in-flight step prevents completion", () => {
  const { db, m } = setup(); m.startStep("window", "owner", steps[0], 99);
  assert.throws(() => m.finishStep("window", "owner", steps[0], 100), /evidence_expired/u); assertInvalid(m, "evidence_expired"); db.close();
});

test("revocation atomically invalidates holder and rejects re-acquisition", () => {
  const { db, m } = setup(); m.revokeEvidence("evidence", 4); assertInvalid(m, "evidence_revoked");
  assert.throws(() => m.acquire({ id: "again", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 5 }), /evidence_unavailable/u); db.close();
});

test("evidence revision drift and clock rollback fail closed", () => {
  const first = setup(); first.db.prepare("UPDATE fixture_window_evidence SET revision=2 WHERE id='evidence'").run();
  assert.throws(() => first.m.startStep("window", "owner", steps[0], 4), /evidence_changed/u); assertInvalid(first.m, "evidence_changed"); first.db.close();
  const second = setup(); assert.throws(() => second.m.startStep("window", "owner", steps[0], 2), /clock_rollback/u); assertInvalid(second.m, "clock_rollback"); second.db.close();
});

test("owner mismatch, duplicate holder, out-of-order steps and incomplete completion reject", () => {
  const { db, m } = setup();
  assert.throws(() => m.startStep("window", "other", steps[0], 4), /owner_mismatch/u);
  assert.throws(() => m.acquire({ id: "other", owner: "other", freezeId: "freeze", evidenceId: "evidence", now: 4 }), /UNIQUE constraint failed/u);
  assert.throws(() => m.startStep("window", "owner", steps[1], 4), /step_order_or_inflight/u);
  assert.throws(() => m.finishWindow("window", "owner", 4), /steps_incomplete/u);
  assert.equal(m.window("window").state, "held"); db.close();
});

test("repeated completion is idempotent without duplicate audit", () => {
  const { db, m } = setup(); m.startStep("window", "owner", steps[0], 4);
  m.finishStep("window", "owner", steps[0], 5);
  assert.equal(m.finishStep("window", "owner", steps[0], 6).alreadyFinished, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action='step_finished'").get().n, 1); db.close();
});

test("restart invalidates an uncertain in-flight step instead of resuming it", () => {
  const { db, m } = setup(); m.startStep("window", "owner", steps[0], 4); m.restart();
  assertInvalid(m, "process_interrupted"); assert.throws(() => m.finishStep("window", "owner", steps[0], 5), /window_not_held/u); db.close();
});

test("missing freeze identity never creates or releases a window", () => {
  const db = new DatabaseSync(":memory:"); const m = new LocalBackupWindowFixture(db);
  assert.throws(() => m.release(null, 1), /invalid_freeze_id/u);
  assert.throws(() => m.evidence("e", null, 10, 1), /invalid_evidence/u);
  assert.equal(m.gate().freeze_id, null); db.close();
});

test("rejected evidence cannot be inferred from URL expiry or an unknown proof", () => {
  const db = new DatabaseSync(":memory:"); const m = new LocalBackupWindowFixture(db); m.freeze("freeze", 1);
  assert.throws(() => m.acquire({ id: "w", owner: "owner", freezeId: "freeze", evidenceId: "unknown", now: 2 }), /evidence_unavailable/u);
  assert.throws(() => m.evidence("expired", "freeze", 2, 2), /invalid_evidence_scope_or_expiry/u); db.close();
});

async function crashAt(stage) {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-fixture-")); const file = path.join(root, "fixture.sqlite");
  let db = new DatabaseSync(file); const m = new LocalBackupWindowFixture(db); m.freeze("freeze", 1); m.evidence("evidence", "freeze", 100, 2); m.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 2 }); db.close();
  const child = spawn(process.execPath, [path.resolve("scripts/local-backup-window-child.mjs"), file, stage], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout.on("data", (chunk) => { output += chunk.toString(); }); child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    let ready = false;
    for (let i = 0; i < 300; i += 1) { if (output.includes(`${stage}\n`)) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.equal(ready, true, `checkpoint not reached: ${errors}`); child.kill("SIGKILL"); assert.equal((await closed).signal, "SIGKILL");
    db = new DatabaseSync(file); const restarted = new LocalBackupWindowFixture(db);
    assert.equal(restarted.window("window").inflight, stage === "before_commit" ? null : "d1_export");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action='step_started'").get().n, stage === "before_commit" ? 0 : 1);
    restarted.restart(); assertInvalid(restarted, "process_interrupted"); db.close(); db = undefined;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    if (db) db.close(); await rm(root, { recursive: true, force: true });
  }
}
test("SIGKILL before step transaction commit rolls it back and restart invalidates", async () => { await crashAt("before_commit"); });
test("SIGKILL after step transaction commit preserves marker and restart invalidates", async () => { await crashAt("after_commit"); });


test("two processes race to acquire the same frozen window; only one can hold it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-race-")); const file = path.join(root, "fixture.sqlite");
  const db = new DatabaseSync(file); const m = new LocalBackupWindowFixture(db); m.freeze("freeze", 1); m.evidence("evidence", "freeze", 100, 2); db.close();
  const children = ["first", "second"].map((id) => spawn(process.execPath, [path.resolve("scripts/local-backup-window-race-child.mjs"), file, id], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  const waiters = children.map((child) => {
    let output = "", stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const ready = new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => { if (code !== null && code !== 0) reject(new Error(stderr)); }); });
    const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, output, stderr })));
    return { ready, closed };
  });
  try {
    await Promise.all(waiters.map((item) => item.ready)); children.forEach((child) => child.send("go"));
    const results = await Promise.all(waiters.map((item) => item.closed));
    assert.deepEqual(results.map((item) => item.code), [0, 0]);
    assert.equal(results.filter((item) => item.output === "acquired\n").length, 1);
    assert.equal(results.filter((item) => /rejected:.*UNIQUE constraint failed/u.test(item.output)).length, 1);
    const resultDb = new DatabaseSync(file);
    assert.equal(resultDb.prepare("SELECT COUNT(*) AS n FROM fixture_backup_window WHERE state='held'").get().n, 1);
    assert.equal(resultDb.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action='acquired'").get().n, 1);
    resultDb.close();
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(waiters.map((item) => item.closed)); await rm(root, { recursive: true, force: true });
  }
});
