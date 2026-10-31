/* global process */
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 100");
// Schema already exists; avoid the fixture constructor's initialization write.
const model = Object.create(LocalBackupWindowFixture.prototype); model.db = db;
try { model.release("freeze", 4); writeSync(1, "unexpected_release\n"); }
catch (error) { writeSync(1, `rejected:${error.message}\n`); }
db.close();
