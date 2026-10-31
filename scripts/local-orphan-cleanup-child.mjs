/* global process */
import { writeSync } from "node:fs";
import { reopenLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";

process.once("message", ({ root, capability, attemptId }) => {
  const fixture = reopenLocalOrphanFixture(root, capability, () => true);
  fixture.recover(attemptId, { afterRemove: () => {
    writeSync(1, "removed_before_audit\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  } });
  fixture.close();
  process.disconnect();
});
process.send("ready");
