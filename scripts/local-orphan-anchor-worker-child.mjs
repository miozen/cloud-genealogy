/* global process, setTimeout, clearTimeout */
// Test worker: the parent only relays RPC to the separate supervisor process.
import { createPublicKey } from "node:crypto";
import { writeSync } from "node:fs";
import { createLocalGuardedFacade } from "./local-orphan-guarded-facade.mjs";
import { executeFixtureRequest, queryFixtureRequest } from "./local-orphan-idempotency-fixture.mjs";
import { executeWitnessedFixtureRequest, observeWitnessCapacity, queryWitnessedFixtureRequest } from "./local-orphan-witness-fixture.mjs";
import { reopenLocalChallengeFixture } from "./local-orphan-challenge-fixture.mjs";
let fixture, envelope, phase, operation, scope, requestId, nextId = 0;
const waiting = new Map();
const rpc = (method, before, after, binding) => new Promise((resolve) => {
  const id = ++nextId; const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false }); }, 2000);
  waiting.set(id, { resolve, timer }); process.send({ kind: "rpc", id, method, before, after, binding }, (error) => { if (error) { clearTimeout(timer); waiting.delete(id); resolve({ ok: false }); } });
});
const anchor = { check: async (before) => (await rpc("check", before)).ok, prepare: async (before, after, binding) => (await rpc("prepare", before, after, binding)).ok, finalize: async (before, after) => (await rpc("finalize", before, after)).ok, inspect: async (before) => (await rpc("inspect", before)).comparison, observe: async (before) => rpc("observe", before), binding: async (id, hash) => (await rpc("binding", id, hash)).status, capacity: async (before) => rpc("capacity", before) };
process.on("message", async (message) => {
  if (message.kind === "reply") { const pending = waiting.get(message.id); if (pending) { clearTimeout(pending.timer); waiting.delete(message.id); pending.resolve(message); } return; }
  if (message.kind === "init") {
    fixture = reopenLocalChallengeFixture(message.root, message.capability, createPublicKey(message.publicKey));
    envelope = message.envelope; phase = message.phase; operation = message.operation ?? "consume"; scope = message.scope; requestId = message.requestId; process.send({ kind: "ready" }); return;
  }
  if (message.kind === "go") {
    const pause = (point) => { if (phase === point) { writeSync(1, `checkpoint:${point}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); } };
    try {
      const hooks = { beforeCommit: () => pause("before_commit"), afterCommit: () => pause("after_commit") };
      const facade = createLocalGuardedFacade(fixture, anchor, hooks);
      const result = operation === "witness_issue" ? { result: await executeWitnessedFixtureRequest(fixture, anchor, requestId, "issue", scope, hooks) } : operation === "witness_consume" ? { result: await executeWitnessedFixtureRequest(fixture, anchor, requestId, "consume", envelope, hooks) } : operation === "witness_query_issue" ? { result: await queryWitnessedFixtureRequest(fixture, anchor, requestId, "issue", scope) } : operation === "witness_query_consume" ? { result: await queryWitnessedFixtureRequest(fixture, anchor, requestId, "consume", envelope) } : operation === "witness_capacity" ? { evidence: await observeWitnessCapacity(fixture, anchor) } : operation === "request_issue" ? { result: await executeFixtureRequest(fixture, anchor, requestId, "issue", scope, hooks) } : operation === "request_consume" ? { result: await executeFixtureRequest(fixture, anchor, requestId, "consume", envelope, hooks) } : operation === "query_issue" ? { result: await queryFixtureRequest(fixture, anchor, requestId, "issue", scope) } : operation === "query_consume" ? { result: await queryFixtureRequest(fixture, anchor, requestId, "consume", envelope) } : operation === "issue" ? { challenge: await facade.issue(scope) } : operation === "inspect" ? { inspection: await facade.inspect() } : operation === "observe" ? { evidence: await facade.observe() } : operation === "surface" ? { keys: Object.keys(facade).sort(), hasDb: "db" in facade, frozen: Object.isFrozen(facade), nullPrototype: Object.getPrototypeOf(facade) === null } : operation === "consume" ? { accepted: await facade.consume(envelope) } : { error: "operation_unknown" };
      writeSync(1, `${JSON.stringify(result)}\n`);
    }
    catch (error) { writeSync(1, `${JSON.stringify({ error: error.message })}\n`); }
    finally { fixture.close(); process.disconnect(); }
  }
});
