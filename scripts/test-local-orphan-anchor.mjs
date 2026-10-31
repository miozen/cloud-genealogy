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
import { fixtureRequestHash } from "./local-orphan-ledger-integrity-fixture.mjs";

function setup() {
  const orphan = createLocalOrphanFixture(() => true); const model = new LocalBackupWindowFixture(orphan.fixture.db);
  model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
  const attempt = orphan.fixture.plan("window"); mkdirSync(attempt.output); orphan.fixture.attest(attempt.id, attempt.nonce); model.restart();
  const report = observeLocalOrphan(orphan.fixture, attempt.id); const scope = { runId: randomUUID(), rootId: randomUUID(), attemptId: attempt.id };
  const signer = createFixtureSigner(); const holder = createLocalChallengeFixture(signer.publicKey); const challenge = holder.fixture.issue(scope);
  return { orphan, attempt, scope, report, signer, ...holder, challenge, envelope: signer.signObservation(scope, challenge, report), dispose() { this.fixture.close(); rmSync(this.root, { recursive: true, force: true }); orphan.fixture.close(); rmSync(orphan.root, { recursive: true, force: true }); } };
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
function makeWorker(x, supervisor, phase = "", envelope = x.envelope, operation = "consume", scope = x.scope, requestId) {
  const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-anchor-worker-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "", readyResolve;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  child.on("exit", () => readyResolve());
  child.on("message", async (message) => {
    if (message.kind === "ready") readyResolve();
    if (message.kind === "rpc") {
      const result = await supervisor.rpc(message.method, message.before, message.after);
      if (phase === `drop_${message.method}`) return;
      if (phase === `kill_${message.method}`) { child.kill("SIGKILL"); return; }
      if (child.connected) child.send({ kind: "reply", id: message.id, ok: result.ok === true, comparison: result.comparison, state: result.state }, () => {});
    }
  });
  child.send({ kind: "init", root: x.root, capability: x.capability, publicKey: x.signer.publicKey.export({ format: "pem", type: "spki" }), envelope, phase, operation, scope, requestId });
  return { child, ready, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function runWorker(x, supervisor, operation = "consume", envelope = x.envelope, requestId, scope = x.scope) {
  const worker = makeWorker(x, supervisor, "", envelope, operation, scope, requestId); await worker.ready;
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
const evidence = (supervisorState, ledgerComparison) => ({ version: 1, fixtureOnly: true, supervisorState, ledgerComparison, outcome: "review_required", remoteExecutionAvailable: false });
const requestCount = (x) => x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge_request").get().n;

for (const corruption of ["issue_hash", "missing_audit", "consumed_without_audit", "rejected_record", "consume_without_commit", "duplicate_issue", "duplicate_consume", "orphan_reference"]) {
  test(`pre-existing ${corruption} corruption remains blocked even if anchored as a baseline`, async () => {
    const x = setup(); const requestId = randomUUID(); let anchor;
    try {
      let kind = "issue", target = x.challenge, inputHash = fixtureRequestHash("issue", x.scope);
      if (corruption === "issue_hash") inputHash = "a".repeat(64);
      if (corruption === "missing_audit") { x.fixture.db.exec("DROP TRIGGER fixture_challenge_audit_no_delete"); x.fixture.db.prepare("DELETE FROM fixture_challenge_audit WHERE challenge=? AND action='issued'").run(x.challenge); }
      if (corruption === "consumed_without_audit") x.fixture.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=?").run(x.challenge);
      if (corruption === "consume_without_commit") { kind = "consume"; inputHash = fixtureRequestHash("consume", x.envelope); }
      if (corruption === "duplicate_issue" || corruption === "duplicate_consume") x.fixture.db.exec("DROP INDEX fixture_challenge_one_request_per_kind");
      if (corruption === "duplicate_consume") { kind = "consume"; inputHash = fixtureRequestHash("consume", x.envelope); x.fixture.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=?").run(x.challenge); x.fixture.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'consumed')").run(x.challenge); }
      if (corruption === "orphan_reference") { x.fixture.db.exec("PRAGMA foreign_keys=OFF"); target = "b".repeat(64); }
      x.fixture.db.prepare("INSERT INTO fixture_challenge_request VALUES(?,?,?,?,?)").run(requestId, kind, inputHash, target, corruption === "rejected_record" ? 0 : 1);
      if (corruption === "duplicate_issue" || corruption === "duplicate_consume") x.fixture.db.prepare("INSERT INTO fixture_challenge_request VALUES(?,?,?,?,1)").run(randomUUID(), kind, inputHash, target);
      anchor = await boot(x);
      assert.deepEqual(await runWorker(x, anchor, kind === "issue" ? "query_issue" : "query_consume", x.envelope, requestId), { error: "ledger_integrity_invalid" });
      assert.deepEqual(await runWorker(x, anchor, "request_issue", x.envelope, randomUUID()), { error: "ledger_integrity_invalid" });
      if (corruption === "issue_hash") assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: evidence("ready", "matches_current") });
      assert.equal((await anchor.rpc("status")).state, "ready");
    } finally { if (anchor) await anchor.stop(); x.dispose(); }
  });
}

test("schema blocks multiple requests for the same challenge and operation", () => {
  const x = setup(); try {
    const stmt = x.fixture.db.prepare("INSERT INTO fixture_challenge_request VALUES(?,'issue',?,?,1)"); const hash = fixtureRequestHash("issue", x.scope);
    stmt.run(randomUUID(), hash, x.challenge); assert.throws(() => stmt.run(randomUUID(), hash, x.challenge), /UNIQUE constraint failed/u);
  } finally { x.dispose(); }
});

test("consume history linked to a different challenge is rejected even with a matching input hash", async () => {
  const x = setup(); let anchor; const requestId = randomUUID();
  try {
    const other = x.fixture.issue(x.scope); const signedOther = x.signer.signObservation(x.scope, other, x.report); assert.equal(x.fixture.consume(signedOther), true);
    x.fixture.db.prepare("INSERT INTO fixture_challenge_request VALUES(?,'consume',?,?,1)").run(requestId, fixtureRequestHash("consume", x.envelope), other);
    anchor = await boot(x);
    assert.deepEqual(await runWorker(x, anchor, "query_consume", x.envelope, requestId), { error: "ledger_integrity_invalid" });
  } finally { if (anchor) await anchor.stop(); x.dispose(); }
});

test("recorded result remains inaccessible after supervisor loss, even after process restart", async () => {
  const x = setup(); const anchor = await boot(x); let fresh; const requestId = randomUUID();
  try {
    const original = await runWorker(x, anchor, "request_issue", x.envelope, requestId); assert.equal(original.result.status, "recorded");
    const before = challengeLedgerDigest(x.fixture.db); anchor.child.kill("SIGKILL"); await anchor.closed;
    assert.deepEqual(await runWorker(x, anchor, "query_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
    fresh = makeSupervisor(); await fresh.ready;
    assert.deepEqual(await runWorker(x, fresh, "query_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
    assert.equal(challengeLedgerDigest(x.fixture.db), before); assert.equal(requestCount(x), 1);
  } finally { if (fresh) await fresh.stop(); x.dispose(); }
});

test("request record modified after anchoring blocks query before returning history", async () => {
  const x = setup(); const anchor = await boot(x); const requestId = randomUUID();
  try {
    assert.equal((await runWorker(x, anchor, "request_issue", x.envelope, requestId)).result.status, "recorded");
    x.fixture.db.exec("DROP TRIGGER fixture_challenge_request_no_update");
    x.fixture.db.prepare("UPDATE fixture_challenge_request SET input_hash=? WHERE request_id=?").run("f".repeat(64), requestId);
    assert.deepEqual(await runWorker(x, anchor, "query_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
    assert.deepEqual(await runWorker(x, anchor, "request_issue", x.envelope, randomUUID()), { error: "anchor_state_unavailable_or_mismatch" });
  } finally { await anchor.stop(); x.dispose(); }
});

test("same-scope issue record swaps survive structural checks after malicious re-bootstrap", async () => {
  const x = setup(); const anchor = await boot(x); let reset; const a = randomUUID(), b = randomUUID();
  try {
    const first = await runWorker(x, anchor, "request_issue", x.envelope, a); const second = await runWorker(x, anchor, "request_issue", x.envelope, b);
    await anchor.stop(); x.fixture.db.exec("DROP TRIGGER fixture_challenge_request_no_update; DROP INDEX fixture_challenge_one_request_per_kind;");
    x.fixture.db.prepare("UPDATE fixture_challenge_request SET challenge=CASE request_id WHEN ? THEN ? WHEN ? THEN ? ELSE challenge END WHERE request_id IN (?,?)").run(a, second.result.challenge, b, first.result.challenge, a, b);
    reset = await boot(x);
    const forged = await runWorker(x, reset, "query_issue", x.envelope, a);
    assert.equal(forged.result.challenge, second.result.challenge); assert.notEqual(forged.result.challenge, first.result.challenge);
    assert.equal(forged.result.outcome, "review_required");
  } finally { if (reset) await reset.stop(); x.dispose(); }
});

for (const kind of ["issue", "consume"]) {
  test(`concurrent ${kind} requests with one ID return the same recorded result once`, async () => {
    const x = setup(); const anchor = await boot(x); const requestId = randomUUID();
    const operation = `request_${kind}`; const workers = [makeWorker(x, anchor, "", x.envelope, operation, x.scope, requestId), makeWorker(x, anchor, "", x.envelope, operation, x.scope, requestId)];
    try {
      await Promise.all(workers.map((w) => w.ready)); workers.forEach((w) => w.child.send({ kind: "go" }));
      const results = await Promise.all(workers.map((w) => w.closed)); assert.deepEqual(results.map((v) => v.code), [0, 0]);
      const first = JSON.parse(results[0].stdout).result; const second = JSON.parse(results[1].stdout).result;
      assert.deepEqual(first, second); assert.equal(first.kind, kind); assert.equal(first.outcome, "review_required"); assert.equal(first.remoteExecutionAvailable, false);
      assert.equal(requestCount(x), 1); assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, kind === "issue" ? 2 : 1);
      assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge_audit WHERE challenge=? AND action=?").get(first.challenge, kind === "issue" ? "issued" : "consumed").n, 1);
      assert.deepEqual(await runWorker(x, anchor, `query_${kind}`, x.envelope, requestId), { result: first });
      assert.deepEqual(await runWorker(x, anchor, operation, x.envelope, requestId), { result: first });
    } finally { for (const w of workers) if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL"); await Promise.all(workers.map((w) => w.closed)); await anchor.stop(); x.dispose(); }
  });
}

test("request ID cannot be reused with a different scope, operation or envelope", async () => {
  const x = setup(); const anchor = await boot(x); const requestId = randomUUID();
  try {
    const first = await runWorker(x, anchor, "request_issue", x.envelope, requestId);
    assert.equal(first.result.status, "recorded");
    const reordered = { attemptId: x.scope.attemptId, rootId: x.scope.rootId, runId: x.scope.runId };
    assert.deepEqual(await runWorker(x, anchor, "query_issue", x.envelope, requestId, reordered), first);
    assert.deepEqual(await runWorker(x, anchor, "request_issue", x.envelope, requestId, { ...x.scope, rootId: randomUUID() }), { error: "request_conflict" });
    assert.deepEqual(await runWorker(x, anchor, "query_issue", x.envelope, requestId, { ...x.scope, rootId: randomUUID() }), { error: "request_conflict" });
    assert.deepEqual(await runWorker(x, anchor, "request_consume", x.envelope, requestId), { error: "request_conflict" });
    const consumeId = randomUUID(); assert.equal((await runWorker(x, anchor, "request_consume", x.envelope, consumeId)).result.accepted, true);
    const altered = structuredClone(x.envelope); altered.signature = "00".repeat(64);
    assert.deepEqual(await runWorker(x, anchor, "query_consume", altered, consumeId), { error: "request_conflict" });
    assert.equal(requestCount(x), 2); assert.equal((await anchor.rpc("status")).state, "ready");
    assert.throws(() => x.fixture.db.exec("DELETE FROM fixture_challenge_request"), /request_immutable/u);
  } finally { await anchor.stop(); x.dispose(); }
});

test("historical issue result does not claim the challenge remains available after consumption", async () => {
  const x = setup(); const anchor = await boot(x); const issueId = randomUUID();
  try {
    const issued = await runWorker(x, anchor, "request_issue", x.envelope, issueId);
    const signed = x.signer.signObservation(x.scope, issued.result.challenge, x.report);
    const consumedRequest = await runWorker(x, anchor, "request_consume", signed, randomUUID());
    assert.equal(consumedRequest.result.accepted, true);
    assert.equal(x.fixture.db.prepare("SELECT consumed FROM fixture_challenge WHERE challenge=?").get(issued.result.challenge).consumed, 1);
    const historical = await runWorker(x, anchor, "query_issue", x.envelope, issueId);
    assert.deepEqual(historical, issued); assert.equal(historical.result.accepted, null); assert.equal(historical.result.outcome, "review_required");
  } finally { await anchor.stop(); x.dispose(); }
});

test("request prepare acknowledgement loss preserves pending and refuses result query", async () => {
  const x = setup(); const anchor = await boot(x); const requestId = randomUUID(); const worker = makeWorker(x, anchor, "drop_prepare", x.envelope, "request_issue", x.scope, requestId);
  try {
    await worker.ready; worker.child.send({ kind: "go" }); const result = await worker.closed;
    assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { error: "anchor_prepare_refused" });
    assert.equal(requestCount(x), 0); assert.equal((await anchor.rpc("status")).state, "pending");
    assert.deepEqual(await runWorker(x, anchor, "query_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
    assert.deepEqual(await runWorker(x, anchor, "request_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
  } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
});

test("invalid signature reserves no request ID and cannot consume the challenge", async () => {
  const x = setup(); const anchor = await boot(x); const requestId = randomUUID(); const invalid = structuredClone(x.envelope); invalid.signature = "00".repeat(64);
  try {
    assert.deepEqual(await runWorker(x, anchor, "request_consume", invalid, requestId), { result: { status: "rejected", outcome: "review_required", remoteExecutionAvailable: false } });
    assert.equal(requestCount(x), 0); assert.equal(consumed(x), 0);
    assert.equal((await runWorker(x, anchor, "request_consume", x.envelope, requestId)).result.accepted, true);
  } finally { await anchor.stop(); x.dispose(); }
});

for (const kind of ["issue", "consume"]) {
  test(`${kind} finalize response loss can be queried and retried with the same ID`, async () => {
    const x = setup(); const anchor = await boot(x); const requestId = randomUUID(); const operation = `request_${kind}`;
    const worker = makeWorker(x, anchor, "drop_finalize", x.envelope, operation, x.scope, requestId);
    try {
      await worker.ready; worker.child.send({ kind: "go" }); const stopped = await worker.closed;
      assert.equal(stopped.code, 0, stopped.stderr); assert.deepEqual(JSON.parse(stopped.stdout), { error: "anchor_finalize_refused" });
      const query = await runWorker(x, anchor, `query_${kind}`, x.envelope, requestId); assert.equal(query.result.status, "recorded");
      assert.equal(query.result.outcome, "review_required"); assert.equal(query.result.remoteExecutionAvailable, false);
      assert.deepEqual(await runWorker(x, anchor, operation, x.envelope, requestId), query);
      assert.equal(requestCount(x), 1); assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, kind === "issue" ? 2 : 1);
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
  });
}

for (const phase of ["before_commit", "after_commit"]) {
  test(`request SIGKILL ${phase} leaves pending and prevents query or retry`, async () => {
    const x = setup(); const anchor = await boot(x); const requestId = randomUUID(); const worker = makeWorker(x, anchor, phase, x.envelope, "request_issue", x.scope, requestId);
    try {
      await worker.ready; worker.child.send({ kind: "go" }); await waitCheckpoint(worker, phase); worker.child.kill("SIGKILL"); await worker.closed;
      assert.equal(requestCount(x), phase === "before_commit" ? 0 : 1); assert.equal((await anchor.rpc("status")).state, "pending");
      assert.deepEqual(await runWorker(x, anchor, "query_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
      assert.deepEqual(await runWorker(x, anchor, "request_issue", x.envelope, requestId), { error: "anchor_state_unavailable_or_mismatch" });
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
  });
}

test("database and supervisor reset can forget a request and issue a different challenge", async () => {
  const x = setup(); const anchor = await boot(x); const requestId = randomUUID(); const snapshot = path.join(x.root, "request-old.sqlite"); let reset;
  try {
    x.fixture.close(); copyFileSync(path.join(x.root, "challenge.sqlite"), snapshot); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    const original = await runWorker(x, anchor, "request_issue", x.envelope, requestId); await anchor.stop();
    x.fixture.close(); copyFileSync(snapshot, path.join(x.root, "challenge.sqlite")); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    reset = makeSupervisor(); await reset.ready; assert.equal((await reset.rpc("bootstrap", challengeLedgerDigest(x.fixture.db))).ok, true);
    assert.equal((await runWorker(x, reset, "query_issue", x.envelope, requestId)).result.status, "not_found");
    const repeated = await runWorker(x, reset, "request_issue", x.envelope, requestId);
    assert.notEqual(repeated.result.challenge, original.result.challenge); assert.equal(repeated.result.outcome, "review_required");
  } finally { if (reset) await reset.stop(); x.dispose(); }
});

test("test worker exposes only the guarded facade, rejects legacy operations and hides raw db", async () => {
  const x = setup(); const anchor = await boot(x);
  try {
    assert.deepEqual(await runWorker(x, anchor, "surface"), { keys: ["consume", "inspect", "issue", "observe"], hasDb: false, frozen: true, nullPrototype: true });
    assert.deepEqual(await runWorker(x, anchor, "legacy_issue"), { error: "operation_unknown" });
    assert.deepEqual(await runWorker(x, anchor, "db"), { error: "operation_unknown" });
    assert.equal(consumed(x), 0);
  } finally { await anchor.stop(); x.dispose(); }
});

test("read-only state evidence is repeatable and never changes ledger or supervisor state", async () => {
  const x = setup(); const anchor = await boot(x);
  try {
    const digest = challengeLedgerDigest(x.fixture.db);
    assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: evidence("ready", "matches_current") });
    assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: evidence("ready", "matches_current") });
    assert.equal(challengeLedgerDigest(x.fixture.db), digest); assert.equal((await anchor.rpc("status")).state, "ready");
    x.fixture.issue(x.scope);
    assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: evidence("ready", "mismatch") });
    assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
  } finally { await anchor.stop(); x.dispose(); }
});

test("missing supervisor state is visible but a lost connection cannot produce evidence", async () => {
  const x = setup(); const anchor = makeSupervisor(); await anchor.ready;
  try {
    assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: evidence("uninitialized", "unavailable") });
    anchor.child.kill("SIGKILL"); await anchor.closed;
    assert.deepEqual(await runWorker(x, anchor, "observe"), { error: "anchor_observation_unavailable" });
    assert.equal(consumed(x), 0);
  } finally { x.dispose(); }
});

for (const operation of ["consume", "issue"]) {
  for (const stage of ["prepare", "finalize"]) {
    test(`${operation} loses ${stage} acknowledgement: outcome remains unproven and evidence is read-only`, async () => {
      const x = setup(); const anchor = await boot(x); const worker = makeWorker(x, anchor, `drop_${stage}`, x.envelope, operation);
      try {
        await worker.ready; worker.child.send({ kind: "go" }); const result = await worker.closed;
        assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { error: `anchor_${stage}_refused` });
        const expectedState = stage === "prepare" ? evidence("pending", "matches_before") : evidence("ready", "matches_current");
        const digest = challengeLedgerDigest(x.fixture.db);
        assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: expectedState });
        assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: expectedState });
        assert.equal(challengeLedgerDigest(x.fixture.db), digest);
        assert.equal(consumed(x), operation === "consume" && stage === "finalize" ? 1 : 0);
        assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, operation === "issue" && stage === "finalize" ? 2 : 1);
        if (stage === "prepare") assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
        else if (operation === "consume") assert.deepEqual(await runWorker(x, anchor), { accepted: false });
        else assert.match((await runWorker(x, anchor, "issue")).challenge, /^[0-9a-f]{64}$/u); // Unknown result does not block a new issue.
      } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
    });
  }
}

for (const stage of ["prepare", "finalize"]) {
  test(`worker killed after supervisor ${stage} but before reply leaves conservative evidence`, async () => {
    const x = setup(); const anchor = await boot(x); const worker = makeWorker(x, anchor, `kill_${stage}`);
    try {
      await worker.ready; worker.child.send({ kind: "go" }); assert.equal((await worker.closed).signal, "SIGKILL");
      const expectedState = stage === "prepare" ? evidence("pending", "matches_before") : evidence("ready", "matches_current");
      assert.deepEqual(await runWorker(x, anchor, "observe"), { evidence: expectedState });
      assert.equal(consumed(x), stage === "prepare" ? 0 : 1);
      assert.deepEqual(await runWorker(x, anchor), stage === "prepare" ? { error: "anchor_state_unavailable_or_mismatch" } : { accepted: false });
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
  });
}

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

test("guarded issue advances the anchor and its challenge can be signed and consumed", async () => {
  const x = setup(); const anchor = await boot(x);
  try {
    const issued = await runWorker(x, anchor, "issue"); assert.match(issued.challenge, /^[0-9a-f]{64}$/u); assert.notEqual(issued.challenge, x.challenge);
    assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, 2);
    const envelope = x.signer.signObservation(x.scope, issued.challenge, x.report);
    assert.deepEqual(await runWorker(x, anchor, "consume", envelope), { accepted: true });
    assert.deepEqual(await runWorker(x, anchor), { accepted: true });
    assert.equal((await anchor.rpc("check", challengeLedgerDigest(x.fixture.db))).ok, true);
  } finally { await anchor.stop(); x.dispose(); }
});

test("guarded issue audit failure rolls back and leaves the existing challenge usable", async () => {
  const x = setup(); x.fixture.db.exec("CREATE TRIGGER injected_issue_failure BEFORE INSERT ON fixture_challenge_audit WHEN NEW.action='issued' BEGIN SELECT RAISE(ABORT,'injected_issue_failure'); END;");
  const anchor = await boot(x);
  try {
    assert.deepEqual(await runWorker(x, anchor, "issue"), { error: "injected_issue_failure" });
    assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, 1);
    assert.equal((await anchor.rpc("status")).state, "ready"); assert.deepEqual(await runWorker(x, anchor), { accepted: true });
  } finally { await anchor.stop(); x.dispose(); }
});

test("pending inspection without a pending or available anchor refuses without mutation", async () => {
  const x = setup(); const anchor = await boot(x); let fresh;
  try {
    assert.deepEqual(await runWorker(x, anchor, "inspect"), { error: "anchor_inspect_unavailable" });
    anchor.child.kill("SIGKILL"); await anchor.closed; fresh = makeSupervisor(); await fresh.ready;
    assert.deepEqual(await runWorker(x, fresh, "inspect"), { error: "anchor_inspect_unavailable" });
    assert.equal(consumed(x), 0); assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, 1);
  } finally { if (fresh) await fresh.stop(); x.dispose(); }
});

test("unguarded issue or direct SQL changes drift the anchor and block guarded operations", async () => {
  for (const change of ["issue", "sql"]) {
    const x = setup(); const anchor = await boot(x);
    try {
      if (change === "issue") x.fixture.issue(x.scope);
      else x.fixture.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=?").run(x.challenge);
      assert.deepEqual(await runWorker(x, anchor, "issue"), { error: "anchor_state_unavailable_or_mismatch" });
      assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
    } finally { await anchor.stop(); x.dispose(); }
  }
});

test("guarded issue and consume in independent processes serialize and preserve the anchor", async () => {
  const x = setup(); const anchor = await boot(x); const workers = [makeWorker(x, anchor, "", x.envelope, "issue"), makeWorker(x, anchor)];
  try {
    await Promise.all(workers.map((worker) => worker.ready)); workers.forEach((worker) => worker.child.send({ kind: "go" }));
    const result = await Promise.all(workers.map((worker) => worker.closed)); assert.deepEqual(result.map((r) => r.code), [0, 0]);
    assert.match(JSON.parse(result[0].stdout).challenge, /^[0-9a-f]{64}$/u); assert.deepEqual(JSON.parse(result[1].stdout), { accepted: true });
    assert.equal(consumed(x), 1); assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, 2);
    assert.equal((await anchor.rpc("check", challengeLedgerDigest(x.fixture.db))).ok, true);
  } finally { for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await Promise.all(workers.map((worker) => worker.closed)); await anchor.stop(); x.dispose(); }
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
      const inspection = { comparison: phase === "before_commit" ? "matches_before" : "matches_after", disposition: "blocked", remoteExecutionAvailable: false };
      assert.deepEqual(await runWorker(x, anchor, "inspect"), { inspection });
      assert.deepEqual(await runWorker(x, anchor, "inspect"), { inspection }); assert.equal((await anchor.rpc("status")).state, "pending");
      assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
  });
}

for (const phase of ["before_commit", "after_commit"]) {
  test(`guarded issue SIGKILL ${phase} leaves inspectable pending and never releases challenge`, async () => {
    const x = setup(); const anchor = await boot(x); const worker = makeWorker(x, anchor, phase, x.envelope, "issue");
    try {
      await worker.ready; worker.child.send({ kind: "go" }); await waitCheckpoint(worker, phase);
      worker.child.kill("SIGKILL"); assert.equal((await worker.closed).signal, "SIGKILL");
      assert.equal(x.fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge").get().n, phase === "before_commit" ? 1 : 2);
      assert.deepEqual(await runWorker(x, anchor, "inspect"), { inspection: { comparison: phase === "before_commit" ? "matches_before" : "matches_after", disposition: "blocked", remoteExecutionAvailable: false } });
      assert.equal((await anchor.rpc("status")).state, "pending");
      assert.deepEqual(await runWorker(x, anchor, "issue"), { error: "anchor_state_unavailable_or_mismatch" });
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
  });
}

test("unknown drift while pending is inspectable as mismatch and cannot clear pending", async () => {
  const x = setup(); const anchor = await boot(x); const worker = makeWorker(x, anchor, "before_commit");
  try {
    await worker.ready; worker.child.send({ kind: "go" }); await waitCheckpoint(worker, "before_commit"); worker.child.kill("SIGKILL"); await worker.closed;
    x.fixture.issue(x.scope);
    assert.deepEqual(await runWorker(x, anchor, "inspect"), { inspection: { comparison: "mismatch", disposition: "blocked", remoteExecutionAvailable: false } });
    assert.equal((await anchor.rpc("status")).state, "pending");
    assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
  } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
});

test("a rollback after commit can look like before: inspection is not proof of transaction history", async () => {
  const x = setup(); const anchor = await boot(x); const snapshot = path.join(x.root, "old.sqlite");
  x.fixture.close(); copyFileSync(path.join(x.root, "challenge.sqlite"), snapshot); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
  const worker = makeWorker(x, anchor, "after_commit");
  try {
    await worker.ready; worker.child.send({ kind: "go" }); await waitCheckpoint(worker, "after_commit"); worker.child.kill("SIGKILL"); await worker.closed;
    assert.equal(consumed(x), 1); x.fixture.close(); copyFileSync(snapshot, path.join(x.root, "challenge.sqlite")); x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    assert.equal(consumed(x), 0);
    assert.deepEqual(await runWorker(x, anchor, "inspect"), { inspection: { comparison: "matches_before", disposition: "blocked", remoteExecutionAvailable: false } });
    assert.equal((await anchor.rpc("status")).state, "pending"); assert.deepEqual(await runWorker(x, anchor), { error: "anchor_state_unavailable_or_mismatch" });
  } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.closed; } await anchor.stop(); x.dispose(); }
});

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
