/* global process, setTimeout, structuredClone */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
import { createLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";
import { observeLocalOrphan } from "./local-orphan-review-fixture.mjs";
import { createFixtureSigner } from "./local-orphan-signature-fixture.mjs";
import { createLocalChallengeFixture, reopenLocalChallengeFixture } from "./local-orphan-challenge-fixture.mjs";
import { challengeLedgerDigest } from "./local-orphan-anchor-fixture.mjs";

function setup() {
  const orphan = createLocalOrphanFixture(() => true); const model = new LocalBackupWindowFixture(orphan.fixture.db);
  model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
  const attempt = orphan.fixture.plan("window"); mkdirSync(attempt.output); orphan.fixture.attest(attempt.id, attempt.nonce); model.restart();
  const report = observeLocalOrphan(orphan.fixture, attempt.id); const scope = { runId: randomUUID(), rootId: randomUUID(), attemptId: attempt.id };
  const signer = createFixtureSigner(); const holder = createLocalChallengeFixture(signer.publicKey); const challenge = holder.fixture.issue(scope);
  return { orphan, attempt, scope, signer, ...holder, challenge, envelope: signer.signObservation(scope, challenge, report), dispose() { this.fixture.close(); rmSync(this.root, { recursive: true, force: true }); orphan.fixture.close(); rmSync(orphan.root, { recursive: true, force: true }); } };
}
function makeSupervisor() {
  const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-anchor-supervisor-child.mjs")], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child.stderr.resume();
  let id = 0; const waiting = new Map(); let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  child.on("message", (message) => { if (message.ready) readyResolve(); else { waiting.get(message.id)?.(message); waiting.delete(message.id); } });
  child.on("exit", () => { for (const resolve of waiting.values()) resolve({ ok: false }); waiting.clear(); readyResolve(); });
  const rpc = (kind, before, after) => new Promise((resolve) => {
    if (!child.connected) { resolve({ ok: false }); return; }
    const request = ++id; waiting.set(request, resolve); child.send({ id: request, kind, before, after }, (error) => { if (error) { waiting.delete(request); resolve({ ok: false }); } });
  });
  return { child, ready, closed, rpc, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; } };
}
function makeWorker(x, supervisor, phase = "", envelope = x.envelope) {
  const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-anchor-worker-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "", readyResolve;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  child.on("exit", () => readyResolve());
  child.on("message", async (message) => {
    if (message.kind === "ready") readyResolve();
    if (message.kind === "rpc") { const result = await supervisor.rpc(message.method, message.before, message.after); if (child.connected) child.send({ kind: "reply", id: message.id, ok: result.ok === true }, () => {}); }
  });
  child.send({ kind: "init", root: x.root, capability: x.capability, publicKey: x.signer.publicKey.export({ format: "pem", type: "spki" }), envelope, phase });
  return { child, ready, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function runWorker(x, supervisor) {
  const worker = makeWorker(x, supervisor); await worker.ready;
  if (!worker.child.connected) throw new Error(`worker failed: ${worker.stderr}`);
  worker.child.send({ kind: "go" }); const result = await worker.closed;
  assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout.trim());
}
async function waitCheckpoint(worker, phase) {
  for (let i = 0; i < 500; i += 1) { if (worker.stdout.includes(`checkpoint:${phase}\n`)) return; if (worker.child.exitCode !== null || worker.child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`checkpoint not reached: ${worker.stderr}`);
}
async function boot(x) { const anchor = makeSupervisor(); await anchor.ready; assert.equal((await anchor.rpc("bootstrap", challengeLedgerDigest(x.fixture.db))).ok, true); return anchor; }
function consumed(x) { return x.fixture.db.prepare("SELECT consumed FROM fixture_challenge WHERE challenge=?").get(x.challenge).consumed; }

test("supervisor survives worker restart and accepts the signed challenge at most once", async () => {
  const x = setup(); const anchor = await boot(x);
  try {
    assert.deepEqual(await runWorker(x, anchor), { accepted: true }); assert.equal(consumed(x), 1);
    assert.deepEqual(await runWorker(x, anchor), { accepted: false }); assert.equal((await anchor.rpc("status")).state, "ready");
    assert.equal(x.orphan.fixture.record(x.attempt.id).state, "owned");
  } finally { await anchor.stop(); x.dispose(); }
});

test("old database snapshot mismatches independent supervisor and remains blocked", async () => {
  const x = setup(); const anchor = await boot(x); const snapshot = path.join(x.root, "old.sqlite");
  try {
    x.fixture.close(); copyFileSync(path.join(x.root, "challenge.sqlite"), snapshot); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    assert.deepEqual(await runWorker(x, anchor), { accepted: true }); x.fixture.close(); copyFileSync(snapshot, path.join(x.root, "challenge.sqlite"));
    x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey); assert.equal(consumed(x), 0);
    assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" }); assert.equal(consumed(x), 0);
    // The original unguarded API remains reachable and does not consult the anchor.
    assert.equal(x.fixture.consume(x.envelope), true);
  } finally { await anchor.stop(); x.dispose(); }
});

test("supervisor loss and restart without anchor never reinitialize or consume", async () => {
  const x = setup(); const anchor = await boot(x); let fresh;
  try {
    anchor.child.kill("SIGKILL"); assert.equal((await anchor.closed).signal, "SIGKILL"); fresh = makeSupervisor(); await fresh.ready;
    assert.equal((await fresh.rpc("status")).state, "uninitialized");
    assert.deepEqual(await runWorker(x, fresh), { error: "anchor_state_unavailable_or_mismatch" }); assert.equal(consumed(x), 0);
  } finally { if (fresh) await fresh.stop(); x.dispose(); }
});

test("database state or audit tampering invalidates anchor without consuming", async () => {
  const x = setup(); const anchor = await boot(x);
  try {
    x.fixture.db.exec("DROP TRIGGER fixture_challenge_audit_no_delete");
    assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" }); assert.equal(consumed(x), 0);
  } finally { await anchor.stop(); x.dispose(); }
});

test("two independent guarded workers race; one consumes and the other refuses replay", async () => {
  const x = setup(); const anchor = await boot(x); const workers = [makeWorker(x, anchor), makeWorker(x, anchor)];
  try {
    await Promise.all(workers.map((worker) => worker.ready)); workers.forEach((worker) => worker.child.send({ kind: "go" }));
    const results = await Promise.all(workers.map((worker) => worker.closed)); assert.deepEqual(results.map((r) => r.code), [0, 0]);
    assert.deepEqual(results.map((r) => JSON.parse(r.stdout).accepted).sort(), [false, true]);
    assert.equal(consumed(x), 1); assert.equal((await anchor.rpc("status")).state, "ready");
  } finally { for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await Promise.all(workers.map((worker) => worker.closed)); await anchor.stop(); x.dispose(); }
});

test("invalid signature leaves the supervisor ready and challenge unconsumed", async () => {
  const x = setup(); const anchor = await boot(x); const invalid = structuredClone(x.envelope); invalid.signature = "00".repeat(64);
  const worker = makeWorker(x, anchor, "", invalid);
  try {
    await worker.ready; worker.child.send({ kind: "go" }); const result = await worker.closed;
    assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { accepted: false });
    assert.equal(consumed(x), 0); assert.equal((await anchor.rpc("status")).state, "ready");
    assert.deepEqual(await runWorker(x, anchor), { accepted: true });
  } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
});

test("supervisor and worker loss during a prepared transition leaves no automatic recovery", async () => {
  const x = setup(); const anchor = await boot(x); const worker = makeWorker(x, anchor, "before_commit"); let fresh;
  try {
    await worker.ready; worker.child.send({ kind: "go" }); await waitCheckpoint(worker, "before_commit");
    anchor.child.kill("SIGKILL"); assert.equal((await anchor.closed).signal, "SIGKILL");
    worker.child.kill("SIGKILL"); assert.equal((await worker.closed).signal, "SIGKILL");
    assert.equal(consumed(x), 0); fresh = makeSupervisor(); await fresh.ready;
    assert.deepEqual(await runWorker(x, fresh), { error: "anchor_state_unavailable_or_mismatch" });
    assert.equal(consumed(x), 0);
  } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } if (fresh) await fresh.stop(); x.dispose(); }
});

for (const phase of ["before_commit", "after_commit"]) {
  test(`worker SIGKILL ${phase} leaves supervisor pending and subsequent worker blocked`, async () => {
    const x = setup(); const anchor = await boot(x); const worker = makeWorker(x, anchor, phase);
    try {
      await worker.ready; worker.child.send({ kind: "go" }); await waitCheckpoint(worker, phase);
      worker.child.kill("SIGKILL"); assert.equal((await worker.closed).signal, "SIGKILL");
      assert.equal((await anchor.rpc("status")).state, "pending"); assert.equal(consumed(x), phase === "before_commit" ? 0 : 1);
      assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
  });
}

test("a fresh supervisor bootstrapped from a rolled-back database permits replay: anchor reset counterexample", async () => {
  const x = setup(); const anchor = await boot(x); let reset; const snapshot = path.join(x.root, "old.sqlite");
  try {
    x.fixture.close(); copyFileSync(path.join(x.root, "challenge.sqlite"), snapshot); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    assert.deepEqual(await runWorker(x, anchor), { accepted: true }); await anchor.stop();
    x.fixture.close(); copyFileSync(snapshot, path.join(x.root, "challenge.sqlite")); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    reset = makeSupervisor(); await reset.ready; assert.equal((await reset.rpc("bootstrap", challengeLedgerDigest(x.fixture.db))).ok, true);
    assert.deepEqual(await runWorker(x, reset), { accepted: true });
  } finally { if (reset) await reset.stop(); x.dispose(); }
});
