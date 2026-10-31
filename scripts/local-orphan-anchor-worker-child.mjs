/* global process */
// Test worker: the parent only relays RPC to the separate supervisor process.
import { createPublicKey } from "node:crypto";
import { writeSync } from "node:fs";
import { guardedFixtureConsume } from "./local-orphan-anchor-fixture.mjs";
import { reopenLocalChallengeFixture } from "./local-orphan-challenge-fixture.mjs";
let fixture, envelope, phase, nextId = 0;
const waiting = new Map();
const rpc = (method, before, after) => new Promise((resolve) => {
  const id = ++nextId; waiting.set(id, resolve); process.send({ kind: "rpc", id, method, before, after });
});
const anchor = { check: (before) => rpc("check", before), prepare: (before, after) => rpc("prepare", before, after), finalize: (before, after) => rpc("finalize", before, after) };
process.on("message", async (message) => {
  if (message.kind === "reply") { waiting.get(message.id)?.(message.ok); waiting.delete(message.id); return; }
  if (message.kind === "init") {
    fixture = reopenLocalChallengeFixture(message.root, message.capability, createPublicKey(message.publicKey));
    envelope = message.envelope; phase = message.phase; process.send({ kind: "ready" }); return;
  }
  if (message.kind === "go") {
    const pause = (point) => { if (phase === point) { writeSync(1, `checkpoint:${point}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); } };
    try { writeSync(1, `${JSON.stringify({ accepted: await guardedFixtureConsume(fixture, envelope, anchor, { beforeCommit: () => pause("before_commit"), afterCommit: () => pause("after_commit") }) })}\n`); }
    catch (error) { writeSync(1, `${JSON.stringify({ error: error.message })}\n`); }
    finally { fixture.close(); process.disconnect(); }
  }
});
