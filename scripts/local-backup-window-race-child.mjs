/* global process */
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";

const [file, id] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 5000");
const model = new LocalBackupWindowFixture(db);
process.on("message", (message) => {
  if (message !== "go") return;
  try {
    model.acquire({ id, owner: id, freezeId: "freeze", evidenceId: "evidence", now: 3 });
    writeSync(1, "acquired\n");
  } catch (error) {
    writeSync(1, `rejected:${error.message}\n`);
  }
  db.close();
  process.disconnect();
});
process.send("ready");
