/* global process */
import { writeSync } from "node:fs";
import { reopenLocalOrphanFixture } from "./local-orphan-recovery-fixture.mjs";
let fixture;
process.on("message", (message) => {
  if (message.kind === "init") {
    fixture = reopenLocalOrphanFixture(message.root, message.capability, () => true);
    process.send("ready");
  } else if (message.kind === "go") {
    try { writeSync(1, `${JSON.stringify(fixture.recover(message.attemptId))}\n`); }
    catch (error) { writeSync(1, `${JSON.stringify({ error: error.message })}\n`); }
    fixture.close(); process.disconnect();
  }
});
