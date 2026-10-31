/* global process */
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
const [file, stage] = process.argv.slice(2);
const db = new DatabaseSync(file);
const model = new LocalBackupWindowFixture(db);
model.startStep("window", "owner", "d1_export", 3, () => {
  if (stage === "before_commit") {
    writeSync(1, "before_commit\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
});
if (stage === "after_commit") {
  writeSync(1, "after_commit\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
}
db.close();
