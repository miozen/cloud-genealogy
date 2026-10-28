/* global process, Buffer */
import { DatabaseSync } from "node:sqlite";
import { CrossStoreRecoveryPrototype } from "./cross-store-recovery-prototype.mjs";
import { FileObjectStoreFixture } from "./file-object-store-fixture.mjs";

const [dbPath, objectRoot, mode, itemId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 10000");
const pauseUntilKilled = () => { process.send?.({ event: "crash-point" }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); };
const store = new FileObjectStoreFixture(objectRoot, mode === "crash-copy" ? pauseUntilKilled : undefined);
const prototype = new CrossStoreRecoveryPrototype(db, store);
process.send?.({ event: "ready" });
process.on("message", (message) => {
  if (message !== "go") return;
  try {
    if (mode === "crash-finalize") prototype.finalize(itemId, { afterPublication: pauseUntilKilled });
    else prototype.copy(itemId, Buffer.from("persistent fixture"));
    process.send?.({ event: "done" }, () => { db.close(); process.exit(0); });
  } catch (error) {
    process.send?.({ event: "error", message: error instanceof Error ? error.message : String(error) }, () => { db.close(); process.exit(1); });
  }
});
