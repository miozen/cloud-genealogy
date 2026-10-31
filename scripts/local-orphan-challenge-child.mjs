/* global process */
// Isolated test process; key and capability are delivered through IPC only.
import { createPublicKey } from "node:crypto";
import { writeSync } from "node:fs";
import { reopenLocalChallengeFixture } from "./local-orphan-challenge-fixture.mjs";
let fixture; let envelope; let phase;
process.on("message", (message) => {
  if (message.kind === "init") {
    fixture = reopenLocalChallengeFixture(message.root, message.capability, createPublicKey(message.publicKey));
    envelope = message.envelope; phase = message.phase; process.send("ready");
  } else if (message.kind === "go") {
    const pause = (point) => { if (phase === point) { writeSync(1, `checkpoint:${point}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); } };
    try { writeSync(1, `${JSON.stringify({ accepted: fixture.consume(envelope, { beforeCommit: () => pause("before_commit"), afterCommit: () => pause("after_commit") }) })}\n`); }
    catch (error) { writeSync(1, `${JSON.stringify({ error: error.message })}\n`); }
    finally { fixture.close(); process.disconnect(); }
  }
});
