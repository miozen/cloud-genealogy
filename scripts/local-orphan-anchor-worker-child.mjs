/* global process */
// Test worker: the parent only relays RPC to the separate supervisor process.
import { createPublicKey } from "node:crypto";
import { writeSync } from "node:fs";
import { guardedFixtureConsume, guardedFixtureIssue, inspectFixturePending } from "./local-orphan-anchor-fixture.mjs";
import { reopenLocalChallengeFixture } from "./local-orphan-challenge-fixture.mjs";
let fixture, envelope, phase, operation, scope, nextId = 0;
const waiting = new Map();
const rpc = (method, before, after) => new Promise((resolve) => {
  const id = ++nextId; waiting.set(id, resolve); process.send({ kind: "rpc", id, method, before, after });
});
const anchor = { check: async (before) => (await rpc("check", before)).ok, prepare: async (before, after) => (await rpc("prepare", before, after)).ok, finalize: async (before, after) => (await rpc("finalize", before, after)).ok, inspect: async (before) => (await rpc("inspect", before)).comparison };
process.on("message", async (message) => {
  if (message.kind === "reply") { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
  if (message.kind === "init") {
    fixture = reopenLocalChallengeFixture(message.root, message.capability, createPublicKey(message.publicKey));
    envelope = message.envelope; phase = message.phase; operation = message.operation ?? "consume"; scope = message.scope; process.send({ kind: "ready" }); return;
  }
  if (message.kind === "go") {
    const pause = (point) => { if (phase === point) { writeSync(1, `checkpoint:${point}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); } };
    try {
      const hooks = { beforeCommit: () => pause("before_commit"), afterCommit: () => pause("after_commit") };
      const result = operation === "issue" ? { challenge: await guardedFixtureIssue(fixture, scope, anchor, hooks) } : operation === "inspect" ? { inspection: await inspectFixturePending(fixture, anchor) } : operation === "consume" ? { accepted: await guardedFixtureConsume(fixture, envelope, anchor, hooks) } : { error: "operation_unknown" };
      writeSync(1, `${JSON.stringify(result)}\n`);
    }
    catch (error) { writeSync(1, `${JSON.stringify({ error: error.message })}\n`); }
    finally { fixture.close(); process.disconnect(); }
  }
});
