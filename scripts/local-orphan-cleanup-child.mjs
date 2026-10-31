/* global process */
import { writeSync } from "node:fs";
import { reopenLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";

process.once("message", ({ root, capability, attemptId, checkpoint }) => {
  const fixture = reopenLocalOrphanFixture(root, capability, () => true);
  const pause = (point, timeout = 30000) => {
    writeSync(1, `${point}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
  };
  fixture.recover(attemptId, { beforeEntry: (entry) => {
    if (checkpoint === `before:${entry}`) pause(checkpoint, 2000);
  }, afterEntry: (entry) => {
    if (checkpoint === entry) pause(`entry:${entry}`);
  }, afterRemove: () => {
    if (!checkpoint) pause("removed_before_audit");
  } });
  fixture.close();
  process.disconnect();
});
process.send("ready");
