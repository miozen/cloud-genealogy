/* global process, setTimeout, structuredClone */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
import { createLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";
import { observeLocalOrphan } from "./local-orphan-review-fixture.mjs";
import { createFixtureSigner } from "./local-orphan-signature-fixture.mjs";
import { createLocalChallengeFixture, reopenLocalChallengeFixture } from "./local-orphan-challenge-fixture.mjs";

function setup() {
  const orphan = createLocalOrphanFixture(() => true); const model = new LocalBackupWindowFixture(orphan.fixture.db);
  model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
  const attempt = orphan.fixture.plan("window"); mkdirSync(attempt.output); orphan.fixture.attest(attempt.id, attempt.nonce); model.restart();
  const report = observeLocalOrphan(orphan.fixture, attempt.id); const scope = { runId: randomUUID(), rootId: randomUUID(), attemptId: attempt.id };
  const signer = createFixtureSigner(); const holder = createLocalChallengeFixture(signer.publicKey); const challenge = holder.fixture.issue(scope);
  const envelope = signer.signObservation(scope, challenge, report);
  return { orphan, attempt, scope, report, signer, ...holder, challenge, envelope, dispose() { this.fixture.close(); rmSync(this.root, { recursive: true, force: true }); orphan.fixture.close(); rmSync(orphan.root, { recursive: true, force: true }); } };
}
function count(fixture, challenge, action) { return fixture.db.prepare("SELECT COUNT(*) n FROM fixture_challenge_audit WHERE challenge=? AND action=?").get(challenge, action).n; }
function childFor(x, phase = "", envelope = x.envelope) {
  const child = spawn(process.execPath, [path.resolve("scripts/local-orphan-challenge-child.mjs")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code, signal) => reject(new Error(`child exited before ready: ${code ?? signal}`))); });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  child.send({ kind: "init", root: x.root, capability: x.capability, publicKey: x.signer.publicKey.export({ format: "pem", type: "spki" }), envelope, phase });
  return { child, ready, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function checkpoint(channel, phase) {
  for (let i = 0; i < 500; i += 1) { if (channel.stdout.includes(`checkpoint:${phase}\n`)) return; if (channel.child.exitCode !== null || channel.child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`checkpoint not reached: ${channel.stderr}`);
}

test("valid signature is consumed once and remains consumed after reopening", () => {
  const x = setup(); try {
    assert.equal(x.fixture.consume(x.envelope), true); assert.equal(x.fixture.consume(x.envelope), false);
    const resumed = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
    try { assert.equal(resumed.consume(x.envelope), false); assert.equal(count(resumed, x.challenge, "issued"), 1); assert.equal(count(resumed, x.challenge, "consumed"), 1); }
    finally { resumed.close(); }
    assert.equal(x.orphan.fixture.record(x.attempt.id).state, "owned"); assert.equal(x.envelope.payload.report.evidence.remoteExecutionAvailable, false);
  } finally { x.dispose(); }
});

test("invalid signatures, scope and unknown challenges never consume a pending record", () => {
  const x = setup(); try {
    for (const mutate of [
      (v) => { v.signature = "00".repeat(64); }, (v) => { v.payload.scope.rootId = randomUUID(); },
      (v) => { v.payload.report.evidence.marker = "modified"; }, (v) => { v.payload.challenge = "a".repeat(64); },
      (v) => { v.payload.protocol = "unknown"; },
    ]) { const invalid = structuredClone(x.envelope); mutate(invalid); assert.equal(x.fixture.consume(invalid), false); }
    assert.equal(count(x.fixture, x.challenge, "consumed"), 0); assert.equal(x.fixture.consume(x.envelope), true);
  } finally { x.dispose(); }
});

test("fixture reopen requires matching capability, key and private root", () => {
  const x = setup(); try {
    assert.throws(() => reopenLocalChallengeFixture(x.root, "wrong", x.signer.publicKey), /challenge_identity_invalid/u);
    assert.throws(() => reopenLocalChallengeFixture(x.root, x.capability, createFixtureSigner().publicKey), /challenge_identity_invalid/u);
    assert.throws(() => reopenLocalChallengeFixture(tmpdir(), x.capability, x.signer.publicKey), /challenge_root_invalid/u);
  } finally { x.dispose(); }
});

test("audit insertion failure rolls back consumption and allows safe retry", () => {
  const x = setup(); try {
    x.fixture.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON fixture_challenge_audit WHEN NEW.action='consumed' BEGIN SELECT RAISE(ABORT,'injected_audit_failure'); END;");
    assert.throws(() => x.fixture.consume(x.envelope), /injected_audit_failure/u); assert.equal(count(x.fixture, x.challenge, "consumed"), 0);
    x.fixture.db.exec("DROP TRIGGER injected_failure"); assert.equal(x.fixture.consume(x.envelope), true);
    assert.throws(() => x.fixture.db.exec("DELETE FROM fixture_challenge_audit"), /audit_immutable/u);
  } finally { x.dispose(); }
});

test("before-commit failure rolls back; after-commit failure leaves consumed and blocks retry", () => {
  const x = setup(); try {
    assert.throws(() => x.fixture.consume(x.envelope, { beforeCommit: () => { throw new Error("before_failure"); } }), /before_failure/u);
    assert.equal(count(x.fixture, x.challenge, "consumed"), 0);
    assert.throws(() => x.fixture.consume(x.envelope, { afterCommit: () => { throw new Error("after_failure"); } }), /after_failure/u);
    assert.equal(count(x.fixture, x.challenge, "consumed"), 1); assert.equal(x.fixture.consume(x.envelope), false);
  } finally { x.dispose(); }
});

test("two independent processes race; exactly one consumes and one audit is committed", async () => {
  const x = setup(); const children = [childFor(x), childFor(x)];
  try {
    await Promise.all(children.map((item) => item.ready)); children.forEach((item) => item.child.send({ kind: "go" }));
    const outputs = await Promise.all(children.map((item) => item.closed)); assert.deepEqual(outputs.map((item) => item.code), [0, 0]);
    assert.deepEqual(outputs.map((item) => JSON.parse(item.stdout).accepted).sort(), [false, true]);
    assert.equal(count(x.fixture, x.challenge, "consumed"), 1); assert.equal(x.fixture.consume(x.envelope), false);
  } finally { for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL"); await Promise.all(children.map((item) => item.closed)); x.dispose(); }
});

test("an invalid competing signature cannot consume or block the valid signed challenge", async () => {
  const x = setup(); const invalid = structuredClone(x.envelope); invalid.signature = "00".repeat(64);
  const children = [childFor(x, "", invalid), childFor(x)];
  try {
    await Promise.all(children.map((item) => item.ready)); children.forEach((item) => item.child.send({ kind: "go" }));
    const outputs = await Promise.all(children.map((item) => item.closed)); assert.deepEqual(outputs.map((item) => item.code), [0, 0]);
    assert.deepEqual(outputs.map((item) => JSON.parse(item.stdout).accepted), [false, true]);
    assert.equal(count(x.fixture, x.challenge, "consumed"), 1);
  } finally { for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL"); await Promise.all(children.map((item) => item.closed)); x.dispose(); }
});

for (const phase of ["before_commit", "after_commit"]) {
  test(`SIGKILL ${phase} recovers conservative single-consumption state`, async () => {
    const x = setup(); const channel = childFor(x, phase);
    try {
      await channel.ready; channel.child.send({ kind: "go" }); await checkpoint(channel, phase);
      channel.child.kill("SIGKILL"); assert.equal((await channel.closed).signal, "SIGKILL");
      const resumed = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey);
      try {
        assert.equal(count(resumed, x.challenge, "consumed"), phase === "before_commit" ? 0 : 1);
        assert.equal(resumed.consume(x.envelope), phase === "before_commit"); assert.equal(resumed.consume(x.envelope), false);
        assert.equal(count(resumed, x.challenge, "consumed"), 1);
      } finally { resumed.close(); }
    } finally { if (channel.child.exitCode === null && channel.child.signalCode === null) { channel.child.kill("SIGKILL"); await channel.closed; } x.dispose(); }
  });
}

test("restoring an old SQLite snapshot permits replay: local persistence is not rollback protection", () => {
  const x = setup(); const snapshot = path.join(x.root, "old.sqlite");
  try {
    x.fixture.close(); copyFileSync(path.join(x.root, "challenge.sqlite"), snapshot);
    x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey); assert.equal(x.fixture.consume(x.envelope), true);
    x.fixture.close(); copyFileSync(snapshot, path.join(x.root, "challenge.sqlite"));
    x.fixture = reopenLocalChallengeFixture(x.root, x.capability, x.signer.publicKey); assert.equal(x.fixture.consume(x.envelope), true);
    assert.equal(count(x.fixture, x.challenge, "consumed"), 1);
  } finally { x.dispose(); }
});
