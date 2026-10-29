/* global process */
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { recoverLocalAdmission } from "./local-admission-recovery-fixture.mjs";

const [dbPath, encoded, checkpoint] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
const input = JSON.parse(encoded);
recoverLocalAdmission(db, { ...input, stopped: () => true, onCheckpoint(stage) {
  if (stage !== checkpoint) return;
  writeSync(1, `${stage}\n`);
  // The parent kills this isolated process at an exact transaction boundary.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
} });
db.close();
