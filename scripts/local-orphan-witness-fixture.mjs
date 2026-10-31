// TEST ONLY: supervisor memory is not a trusted or durable evidence store.
import { createHash, randomBytes } from "node:crypto";
import { challengeLedgerDigest } from "./local-orphan-anchor-fixture.mjs";
import { fixtureRequestDescriptor, lookupFixtureRequest } from "./local-orphan-idempotency-fixture.mjs";
import { validateFixtureLedger } from "./local-orphan-ledger-integrity-fixture.mjs";
import { fixtureCanonicalBytes, verifyFixtureSignature } from "./local-orphan-signature-fixture.mjs";

export function fixtureBindingHash(db, requestId) {
  const row = db.prepare("SELECT kind,input_hash,challenge,accepted FROM fixture_challenge_request WHERE request_id=?").get(requestId);
  if (!row) throw new Error("witness_record_missing");
  const binding = { domain: "cg-local-request-binding-v1", requestId, kind: row.kind, inputHash: row.input_hash, challenge: row.challenge, accepted: row.accepted };
  return createHash("sha256").update(fixtureCanonicalBytes(binding)).digest("hex");
}
async function anchored(fixture, anchor) {
  if (await anchor.check(challengeLedgerDigest(fixture.db)) !== true) throw new Error("anchor_state_unavailable_or_mismatch");
  validateFixtureLedger(fixture.db);
}
async function witnessedLookup(fixture, anchor, descriptor) {
  const record = lookupFixtureRequest(fixture, descriptor);
  const status = await anchor.binding(descriptor.requestId, record ? fixtureBindingHash(fixture.db, descriptor.requestId) : null);
  if (!["match", "mismatch", "missing", "present"].includes(status)) throw new Error("witness_state_unavailable");
  if (record && status === "missing") throw new Error("witness_binding_missing");
  if (record && status !== "match") throw new Error("witness_binding_mismatch");
  if (!record && status !== "missing") throw new Error("witness_record_missing");
  return record && { ...record, historical: true, currentAvailability: "not_evaluated" };
}
// Aggregate observation only; no binding IDs or hashes are returned.
export async function observeWitnessCapacity(fixture, anchor) {
  fixture.db.exec("BEGIN IMMEDIATE");
  try {
    const answer = await anchor.capacity(challengeLedgerDigest(fixture.db));
    const states = { uninitialized: ["unavailable"], ready: ["matches_current", "mismatch"], pending: ["matches_before", "matches_after", "mismatch"] };
    const validCounts = answer?.state === "uninitialized" ? answer.used === null && answer.reserved === null && answer.remaining === null : Number.isSafeInteger(answer?.used) && answer.used >= 0 && answer.used <= 128 && [0, 1].includes(answer.reserved) && answer.remaining === 128 - answer.used - answer.reserved && answer.remaining >= 0 && (answer.state === "pending" || answer.reserved === 0);
    if (!answer || !Object.hasOwn(states, answer.state) || !states[answer.state].includes(answer.comparison) || answer.limit !== 128 || !validCounts) throw new Error("witness_capacity_unavailable");
    return { version: 1, fixtureOnly: true, supervisorState: answer.state, ledgerComparison: answer.comparison, used: answer.used, reserved: answer.reserved, limit: answer.limit, remaining: answer.remaining, outcome: "review_required", remoteExecutionAvailable: false };
  } finally { fixture.db.exec("ROLLBACK"); }
}
export async function queryWitnessedFixtureRequest(fixture, anchor, requestId, kind, input) {
  const descriptor = fixtureRequestDescriptor(requestId, kind, input); fixture.db.exec("BEGIN IMMEDIATE");
  try { await anchored(fixture, anchor); return await witnessedLookup(fixture, anchor, descriptor) ?? { status: "not_found", outcome: "review_required", remoteExecutionAvailable: false }; }
  finally { fixture.db.exec("ROLLBACK"); }
}
export async function executeWitnessedFixtureRequest(fixture, anchor, requestId, kind, input, { beforeCommit = () => {}, afterCommit = () => {} } = {}) {
  const descriptor = fixtureRequestDescriptor(requestId, kind, input); fixture.db.exec("BEGIN IMMEDIATE"); let transaction = true;
  try {
    const before = challengeLedgerDigest(fixture.db); await anchored(fixture, anchor);
    const previous = await witnessedLookup(fixture, anchor, descriptor);
    if (previous) { fixture.db.exec("ROLLBACK"); transaction = false; return previous; }
    let challenge;
    if (kind === "issue") {
      challenge = randomBytes(32).toString("hex");
      fixture.db.prepare("INSERT INTO fixture_challenge(challenge,run_id,root_id,attempt_id,consumed) VALUES(?,?,?,?,0)").run(challenge, input.runId, input.rootId, input.attemptId);
      fixture.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'issued')").run(challenge);
    } else {
      challenge = input.payload.challenge;
      const row = fixture.db.prepare("SELECT run_id,root_id,attempt_id,consumed FROM fixture_challenge WHERE challenge=?").get(challenge);
      const scope = row && { runId: row.run_id, rootId: row.root_id, attemptId: row.attempt_id };
      if (!row || row.consumed !== 0 || !verifyFixtureSignature(fixture.publicKey, input, scope, challenge)) { fixture.db.exec("ROLLBACK"); transaction = false; return { status: "rejected", outcome: "review_required", remoteExecutionAvailable: false }; }
      if (fixture.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=? AND consumed=0").run(challenge).changes !== 1) throw new Error("challenge_state_changed");
      fixture.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'consumed')").run(challenge);
    }
    fixture.db.prepare("INSERT INTO fixture_challenge_request(request_id,kind,input_hash,challenge,accepted) VALUES(?,?,?,?,1)").run(requestId, kind, descriptor.inputHash, challenge);
    validateFixtureLedger(fixture.db);
    const result = { ...lookupFixtureRequest(fixture, descriptor), historical: true, currentAvailability: "not_evaluated" };
    const after = challengeLedgerDigest(fixture.db); const binding = { requestId, hash: fixtureBindingHash(fixture.db, requestId) };
    if (await anchor.prepare(before, after, binding) !== true) throw new Error("anchor_prepare_refused");
    beforeCommit(); fixture.db.exec("COMMIT"); transaction = false; afterCommit();
    if (await anchor.finalize(before, after) !== true) throw new Error("anchor_finalize_refused");
    return result;
  } catch (error) { if (transaction) fixture.db.exec("ROLLBACK"); throw error; }
}
