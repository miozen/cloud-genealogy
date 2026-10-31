/* global structuredClone */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
import { createLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";
import { observeLocalOrphan } from "./local-orphan-review-fixture.mjs";
import { createFixtureSigner, createFixtureVerifier } from "./local-orphan-signature-fixture.mjs";

function setup() {
  const { root, fixture } = createLocalOrphanFixture(() => true);
  const model = new LocalBackupWindowFixture(fixture.db); model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 });
  const attempt = fixture.plan("window"); mkdirSync(attempt.output); fixture.attest(attempt.id, attempt.nonce); model.restart();
  const report = observeLocalOrphan(fixture, attempt.id); const scope = { runId: randomUUID(), rootId: randomUUID(), attemptId: attempt.id };
  const signer = createFixtureSigner(); const verifier = createFixtureVerifier(signer.publicKey); const challenge = verifier.issue(scope);
  return { root, fixture, attempt, report, scope, signer, verifier, challenge, dispose() { fixture.close(); rmSync(root, { recursive: true, force: true }); } };
}
function rehash(report) { report.sha256 = createHash("sha256").update(JSON.stringify(report.evidence)).digest("hex"); }

test("signed real local observation verifies once without changing state or authorizing cleanup", () => {
  const x = setup(); try {
    const before = x.fixture.record(x.attempt.id).state; const envelope = x.signer.signObservation(x.scope, x.challenge, x.report);
    assert.equal(x.verifier.verifyOnce(envelope), true); assert.equal(x.verifier.verifyOnce(envelope), false);
    assert.equal(envelope.payload.report.evidence.outcome, "review_required"); assert.equal(envelope.payload.report.evidence.remoteExecutionAvailable, false);
    assert.equal(x.fixture.record(x.attempt.id).state, before);
  } finally { x.dispose(); }
});

for (const field of ["runId", "rootId", "attemptId"]) {
  test(`wrong ${field} is rejected and does not consume the valid challenge`, () => {
    const x = setup(); try {
      const envelope = x.signer.signObservation(x.scope, x.challenge, x.report); const changed = structuredClone(envelope); changed.payload.scope[field] = randomUUID();
      assert.equal(x.verifier.verifyOnce(changed), false); assert.equal(x.verifier.verifyOnce(envelope), true);
    } finally { x.dispose(); }
  });
}

test("a properly signed different context is refused by the verifier challenge registry", () => {
  const x = setup(); try {
    const different = { ...x.scope, rootId: randomUUID() }; const wrong = x.signer.signObservation(different, x.challenge, x.report);
    assert.equal(x.verifier.verifyOnce(wrong), false); assert.equal(x.verifier.verifyOnce(x.signer.signObservation(x.scope, x.challenge, x.report)), true);
  } finally { x.dispose(); }
});

test("payload tampering remains rejected even after recomputing the unkeyed report hash", () => {
  const x = setup(); try {
    const envelope = x.signer.signObservation(x.scope, x.challenge, x.report); const changed = structuredClone(envelope);
    changed.payload.report.evidence.marker = "fabricated"; rehash(changed.payload.report);
    assert.equal(x.verifier.verifyOnce(changed), false); assert.equal(x.verifier.verifyOnce(envelope), true);
  } finally { x.dispose(); }
});

test("signature, protocol, challenge, and envelope extensions cannot be substituted", () => {
  const x = setup(); try {
    const envelope = x.signer.signObservation(x.scope, x.challenge, x.report);
    for (const mutate of [
      (v) => { v.signature = "00".repeat(64); }, (v) => { v.signature = "bad"; },
      (v) => { v.payload.protocol = "other"; }, (v) => { v.payload.challenge = "a".repeat(64); },
      (v) => { v.publicKey = "attacker"; }, (v) => { v.payload.extra = true; },
    ]) { const changed = structuredClone(envelope); mutate(changed); assert.equal(x.verifier.verifyOnce(changed), false); }
    assert.equal(x.verifier.verifyOnce(envelope), true);
  } finally { x.dispose(); }
});

test("a signature from an attacker key cannot replace the caller's trusted public key", () => {
  const x = setup(); try {
    const attacker = createFixtureSigner(); const forged = attacker.signObservation(x.scope, x.challenge, x.report);
    assert.equal(x.verifier.verifyOnce(forged), false); assert.equal(x.verifier.verifyOnce(x.signer.signObservation(x.scope, x.challenge, x.report)), true);
  } finally { x.dispose(); }
});

test("unissued challenge and duplicate issuance are rejected", () => {
  const x = setup(); try {
    const unknown = x.signer.signObservation(x.scope, "a".repeat(64), x.report); assert.equal(x.verifier.verifyOnce(unknown), false);
    const fixed = createFixtureVerifier(x.signer.publicKey, { challengeFactory: () => "b".repeat(64) });
    const token = fixed.issue(x.scope); assert.throws(() => fixed.issue(x.scope), /fixture_challenge_invalid/u);
    assert.equal(fixed.verifyOnce(x.signer.signObservation(x.scope, token, x.report)), true); assert.throws(() => fixed.issue(x.scope), /fixture_challenge_invalid/u);
  } finally { x.dispose(); }
});

test("distinct outstanding challenges can verify out of order, once each", () => {
  const x = setup(); try {
    const second = x.verifier.issue(x.scope); assert.notEqual(second, x.challenge);
    const firstEnvelope = x.signer.signObservation(x.scope, x.challenge, x.report);
    const secondEnvelope = x.signer.signObservation(x.scope, second, x.report);
    assert.equal(x.verifier.verifyOnce(secondEnvelope), true); assert.equal(x.verifier.verifyOnce(firstEnvelope), true);
    assert.equal(x.verifier.verifyOnce(secondEnvelope), false); assert.equal(x.verifier.verifyOnce(firstEnvelope), false);
  } finally { x.dispose(); }
});

test("report with a mismatched attempt or approval claim cannot be signed", () => {
  const x = setup(); try {
    const wrong = { ...x.scope, attemptId: randomUUID() }; assert.throws(() => x.signer.signObservation(wrong, x.challenge, x.report), /fixture_input_invalid/u);
    const changed = structuredClone(x.report); changed.evidence.outcome = "approved"; rehash(changed);
    assert.throws(() => x.signer.signObservation(x.scope, x.challenge, changed), /fixture_input_invalid/u);
    changed.evidence.outcome = "review_required"; changed.evidence.remoteExecutionAvailable = true; rehash(changed);
    assert.throws(() => x.signer.signObservation(x.scope, x.challenge, changed), /fixture_input_invalid/u);
    changed.evidence.remoteExecutionAvailable = false; changed.evidence.approved = true; rehash(changed);
    assert.throws(() => x.signer.signObservation(x.scope, x.challenge, changed), /fixture_input_invalid/u);
  } finally { x.dispose(); }
});

test("challenge state lost on restart rejects unissued replay but reused challenge permits replay", () => {
  const x = setup(); try {
    const fixed = () => "c".repeat(64); const first = createFixtureVerifier(x.signer.publicKey, { challengeFactory: fixed });
    const challenge = first.issue(x.scope); const envelope = x.signer.signObservation(x.scope, challenge, x.report);
    assert.equal(first.verifyOnce(envelope), true); assert.equal(first.verifyOnce(envelope), false);
    const restarted = createFixtureVerifier(x.signer.publicKey, { challengeFactory: fixed });
    assert.equal(restarted.verifyOnce(envelope), false); restarted.issue(x.scope);
    assert.equal(restarted.verifyOnce(envelope), true); // Explicit replay counterexample, not durable protection.
  } finally { x.dispose(); }
});

test("signature cannot prove a dishonest signer observed truthful data", () => {
  const x = setup(); try {
    const fabricated = structuredClone(x.report); fabricated.evidence.marker = "matches"; fabricated.evidence.audit = []; rehash(fabricated);
    const envelope = x.signer.signObservation(x.scope, x.challenge, fabricated);
    assert.equal(x.verifier.verifyOnce(envelope), true); assert.equal(envelope.payload.report.evidence.outcome, "review_required");
    assert.notDeepEqual(fabricated, x.report);
  } finally { x.dispose(); }
});

test("a valid signature does not establish freshness after the observed filesystem changes", () => {
  const x = setup(); try {
    const envelope = x.signer.signObservation(x.scope, x.challenge, x.report);
    rmSync(path.join(x.attempt.output, ".fixture-owner.json"));
    assert.equal(x.verifier.verifyOnce(envelope), true); assert.equal(observeLocalOrphan(x.fixture, x.attempt.id).evidence.marker, "missing");
    assert.throws(() => x.fixture.recover(x.attempt.id), /ENOENT/u);
  } finally { x.dispose(); }
});
