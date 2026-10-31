/* global process */
// Test-only child for scheduling a concurrent mutation while observing.
import { existsSync, writeSync } from "node:fs";
import path from "node:path";
import { reopenLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";
import { observeLocalOrphan } from "./local-orphan-review-fixture.mjs";

process.once("message", ({ root, capability, attemptId, point }) => {
  const fixture = reopenLocalOrphanFixture(root, capability, () => true);
  try {
    const report = observeLocalOrphan(fixture, attemptId, { checkpoint: (current) => {
      if (current !== point) return;
      writeSync(1, `checkpoint:${point}\n`);
      const deadline = Date.now() + 15000; const gate = path.join(root, "review-continue");
      while (!existsSync(gate)) {
        if (Date.now() > deadline) throw new Error("checkpoint_timeout");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    } });
    writeSync(1, `${JSON.stringify({ report })}\n`);
  } catch (error) { writeSync(1, `${JSON.stringify({ error: error.message })}\n`); }
  finally { fixture.close(); process.disconnect(); }
});
process.send("ready");
