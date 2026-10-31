// TEST ONLY: request identity is not an authorization or trusted recovery proof.
import { randomBytes } from "node:crypto";
import { challengeLedgerDigest } from "./local-orphan-anchor-fixture.mjs";
import { fixtureRequestHash, validateFixtureLedger } from "./local-orphan-ledger-integrity-fixture.mjs";
import { isFixtureScope, verifyFixtureSignature } from "./local-orphan-signature-fixture.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const challengePattern = /^[0-9a-f]{64}$/u;
function requestDescriptor(requestId, kind, input) {
  if (typeof requestId !== "string" || !uuid.test(requestId) || !["issue", "consume"].includes(kind)) throw new Error("request_invalid");
  if (kind === "issue" && !isFixtureScope(input)) throw new Error("request_invalid");
  if (kind === "consume" && (typeof input?.payload?.challenge !== "string" || !challengePattern.test(input.payload.challenge))) throw new Error("request_invalid");
  return { requestId, kind, input, inputHash: fixtureRequestHash(kind, input) };
}
function lookup(fixture, descriptor) {
  const row = fixture.db.prepare("SELECT kind,input_hash,challenge,accepted FROM fixture_challenge_request WHERE request_id=?").get(descriptor.requestId);
  if (!row) return null;
  if (row.kind !== descriptor.kind || row.input_hash !== descriptor.inputHash) throw new Error("request_conflict");
  if (row.kind === "consume") {
    const target = fixture.db.prepare("SELECT run_id,root_id,attempt_id FROM fixture_challenge WHERE challenge=?").get(row.challenge);
    const scope = target && { runId: target.run_id, rootId: target.root_id, attemptId: target.attempt_id };
    if (descriptor.input.payload.challenge !== row.challenge || !verifyFixtureSignature(fixture.publicKey, descriptor.input, scope, row.challenge)) throw new Error("ledger_integrity_invalid");
  }
  return { status: "recorded", kind: row.kind, challenge: row.challenge, accepted: row.kind === "consume" ? row.accepted === 1 : null, outcome: "review_required", remoteExecutionAvailable: false };
}
async function checkAnchor(fixture, anchor) {
  if (await anchor.check(challengeLedgerDigest(fixture.db)) !== true) throw new Error("anchor_state_unavailable_or_mismatch");
  validateFixtureLedger(fixture.db);
}
export async function queryFixtureRequest(fixture, anchor, requestId, kind, input) {
  const descriptor = requestDescriptor(requestId, kind, input); fixture.db.exec("BEGIN IMMEDIATE");
  try { await checkAnchor(fixture, anchor); return lookup(fixture, descriptor) ?? { status: "not_found", outcome: "review_required", remoteExecutionAvailable: false }; }
  finally { fixture.db.exec("ROLLBACK"); }
}
export async function executeFixtureRequest(fixture, anchor, requestId, kind, input, { beforeCommit = () => {}, afterCommit = () => {} } = {}) {
  const descriptor = requestDescriptor(requestId, kind, input); fixture.db.exec("BEGIN IMMEDIATE"); let transaction = true;
  try {
    const before = challengeLedgerDigest(fixture.db); if (await anchor.check(before) !== true) throw new Error("anchor_state_unavailable_or_mismatch");
    validateFixtureLedger(fixture.db);
    const prior = lookup(fixture, descriptor);
    if (prior) { fixture.db.exec("ROLLBACK"); transaction = false; return prior; }
    let challenge;
    if (kind === "issue") {
      challenge = randomBytes(32).toString("hex");
      fixture.db.prepare("INSERT INTO fixture_challenge(challenge,run_id,root_id,attempt_id,consumed) VALUES(?,?,?,?,0)").run(challenge, input.runId, input.rootId, input.attemptId);
      fixture.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'issued')").run(challenge);
    } else {
      challenge = input.payload.challenge;
      const row = fixture.db.prepare("SELECT run_id,root_id,attempt_id,consumed FROM fixture_challenge WHERE challenge=?").get(challenge);
      const scope = row && { runId: row.run_id, rootId: row.root_id, attemptId: row.attempt_id };
      if (!row || row.consumed !== 0 || !verifyFixtureSignature(fixture.publicKey, input, scope, challenge)) {
        fixture.db.exec("ROLLBACK"); transaction = false; return { status: "rejected", outcome: "review_required", remoteExecutionAvailable: false };
      }
      if (fixture.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=? AND consumed=0").run(challenge).changes !== 1) throw new Error("challenge_state_changed");
      fixture.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'consumed')").run(challenge);
    }
    fixture.db.prepare("INSERT INTO fixture_challenge_request(request_id,kind,input_hash,challenge,accepted) VALUES(?,?,?,?,1)").run(requestId, kind, descriptor.inputHash, challenge);
    validateFixtureLedger(fixture.db);
    const result = lookup(fixture, descriptor); const after = challengeLedgerDigest(fixture.db);
    if (await anchor.prepare(before, after) !== true) throw new Error("anchor_prepare_refused");
    beforeCommit(); fixture.db.exec("COMMIT"); transaction = false; afterCommit();
    if (await anchor.finalize(before, after) !== true) throw new Error("anchor_finalize_refused");
    return result;
  } catch (error) { if (transaction) fixture.db.exec("ROLLBACK"); throw error; }
}
