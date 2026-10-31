// TEST ONLY: in-memory policy wrapper; neither a security boundary nor an approval API.
import { observeWitnessCapacity, queryWitnessedFixtureRequest } from "./local-orphan-witness-fixture.mjs";

const latchErrors = new Set(["anchor_state_unavailable_or_mismatch", "anchor_prepare_refused", "anchor_finalize_refused", "witness_state_unavailable", "witness_binding_missing", "witness_binding_mismatch", "witness_record_missing", "ledger_integrity_invalid", "ledger_integrity_unavailable"]);
export function createFixtureRetentionGate(fixture, anchor) {
  let latched = false;
  const healthy = async () => {
    if (latched) throw new Error("retention_gate_latched");
    let observation;
    try { observation = await observeWitnessCapacity(fixture, anchor); }
    catch { latched = true; throw new Error("retention_state_unavailable"); }
    if (observation.supervisorState !== "ready" || observation.ledgerComparison !== "matches_current") { latched = true; throw new Error("retention_state_unavailable"); }
    return observation;
  };
  const guarded = async (work) => {
    try { return await work(); }
    catch (error) { if (latchErrors.has(error?.message)) latched = true; throw error; }
  };
  const history = async (requestId, kind, input) => {
    await healthy();
    const result = await guarded(() => queryWitnessedFixtureRequest(fixture, anchor, requestId, kind, input));
    return result.status === "not_found" ? { status: "indeterminate", outcome: "review_required", remoteExecutionAvailable: false } : result;
  };
  const execute = async (requestId, kind, input) => {
    const capacity = await healthy();
    const previous = await guarded(() => queryWitnessedFixtureRequest(fixture, anchor, requestId, kind, input));
    if (previous.status !== "not_found") return previous;
    if (capacity.remaining === 0) throw new Error("retention_capacity_exhausted");
    // Without independent, non-rollbackable history, absence is not proof that
    // this ID is new. This strict test policy therefore cannot create records.
    throw new Error("retention_new_request_unproven");
  };
  return Object.freeze(Object.assign(Object.create(null), {
    issue: (requestId, scope) => execute(requestId, "issue", scope),
    consume: (requestId, envelope) => execute(requestId, "consume", envelope),
    history,
    state: () => ({ latched, outcome: "review_required", remoteExecutionAvailable: false }),
  }));
}
