/* global process, Buffer, console, setTimeout */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CrossStoreRecoveryPrototype } from "./cross-store-recovery-prototype.mjs";
import { FileObjectStoreFixture } from "./file-object-store-fixture.mjs";

const root = await mkdtemp(path.join(tmpdir(), "cg-recovery-persist-"));
const dbPath = path.join(root, "fixture.sqlite"); const objectRoot = path.join(root, "objects");
const bytes = Buffer.from("persistent fixture"); const hash = createHash("sha256").update(bytes).digest("hex");
const childScript = path.join(import.meta.dirname, "test-cross-store-child.mjs");
const open = () => { const db = new DatabaseSync(dbPath); db.exec("PRAGMA busy_timeout = 10000"); return db; };
const children = [];
function worker(mode, id) {
  const child = spawn(process.execPath, [childScript, dbPath, objectRoot, mode, id], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const events = []; const waiters = [];
  child.on("message", (message) => { events.push(message); for (const wake of waiters.splice(0)) wake(); });
  const closed = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  children.push({ child, closed });
  async function event(name) {
    while (!events.some((value) => value.event === name)) {
      const result = await Promise.race([new Promise((resolve) => waiters.push(() => resolve(null))), closed, new Promise((_, reject) => { setTimeout(() => reject(new Error(`child timed out: ${mode}/${name}`)), 15000).unref(); })]);
      if (result) throw new Error(`child exited early: ${JSON.stringify(result)}`);
    }
  }
  return { child, closed, event };
}
try {
  await mkdir(objectRoot, { mode: 0o700 });
  let db = open(); let run = new CrossStoreRecoveryPrototype(db, new FileObjectStoreFixture(objectRoot));
  run.prepare("crashcopy", 1, hash); db.close();
  const copied = worker("crash-copy", "crashcopy"); await copied.event("ready"); copied.child.send("go"); await copied.event("crash-point"); copied.child.kill("SIGKILL");
  assert.equal((await copied.closed).signal, "SIGKILL");
  db = open(); run = new CrossStoreRecoveryPrototype(db, new FileObjectStoreFixture(objectRoot));
  assert.equal(run.item("crashcopy").state, "prepared");
  assert.equal(run.copy("crashcopy", bytes).state, "copied"); db.close();

  const finishing = worker("crash-finalize", "crashcopy"); await finishing.event("ready"); finishing.child.send("go"); await finishing.event("crash-point"); finishing.child.kill("SIGKILL");
  assert.equal((await finishing.closed).signal, "SIGKILL");
  db = open(); run = new CrossStoreRecoveryPrototype(db, new FileObjectStoreFixture(objectRoot));
  assert.equal(run.item("crashcopy").state, "copied");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recovery_publication WHERE id = 'crashcopy'").get().n, 0);
  assert.equal(run.finalize("crashcopy").state, "published");
  assert.deepEqual(db.prepare("SELECT action FROM recovery_audit WHERE item_id = 'crashcopy' ORDER BY id").all().map((row) => row.action), ["prepared", "copied", "published"]);
  run.prepare("race", 1, hash); db.close();

  const first = worker("race", "race"); const second = worker("race", "race");
  await Promise.all([first.event("ready"), second.event("ready")]); first.child.send("go"); second.child.send("go");
  const results = await Promise.all([first.closed, second.closed]);
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  db = open(); run = new CrossStoreRecoveryPrototype(db, new FileObjectStoreFixture(objectRoot));
  assert.equal(run.item("race").state, "copied");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recovery_audit WHERE item_id = 'race' AND action = 'copied'").get().n, 1);
  assert.equal(run.finalize("race").state, "published");
  run.prepare("tampered", 1, hash); run.copy("tampered", bytes);
  await writeFile(path.join(objectRoot, "published/1/tampered"), "tampered");
  assert.throws(() => run.finalize("tampered"), /missing or changed/u);
  run.prepare("stale", 1, hash); run.freeze(); run.release();
  assert.throws(() => run.copy("stale", bytes), /stale or frozen/u);
  db.close();
  console.log("Disk SQLite/file fixture: process kill, restart, concurrent create, tamper and stale epoch passed.");
} finally {
  for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL");
  await Promise.all(children.map((entry) => entry.closed));
  await rm(root, { recursive: true, force: true });
}
