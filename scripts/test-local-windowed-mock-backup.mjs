/* global process, Buffer, setTimeout */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalBackupWindowFixture } from "./local-backup-window-fixture.mjs";
import { runLocalWindowedMock, verifyLocalWindowedMock } from "./local-windowed-mock-backup.mjs";

const stages = ["d1_export", "media_inventory", "media_download", "verify", "finalize"];
const bytes = "isolated object";
const inventory = { formatVersion: 2, source: "local_d1", counts: { person: 1 }, mediaAssets: [{ mediaAssetId: "11111111-1111-4111-8111-111111111111", objectKey: "media/fixture", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: Buffer.byteLength(bytes), mimeType: "image/jpeg", state: "active", activeReferenceCount: 1 }] };
const adapter = (freezeId) => ({ quiescence: async () => ({ freezeId, freezeActive: true, activeWrites: 0, pendingUploads: 0 }), exportD1: (file) => writeFile(file, "-- fixture\n"), inventory: async () => inventory, downloadObject: (_key, file) => writeFile(file, bytes) });
const absent = async (target) => assert.rejects(access(target), { code: "ENOENT" });
const options = (root, model, clock, freezeId = "freeze", windowId = "window") => ({ output: path.join(root, "attempt"), migrationDir: path.resolve("migrations"), gitCommit: "abcdef1", adapter: adapter(freezeId), freezeId, model, windowId, owner: "owner", now: () => clock.value });
function setup(db) { const model = new LocalBackupWindowFixture(db); model.freeze("freeze", 1); model.evidence("evidence", "freeze", 100, 2); model.acquire({ id: "window", owner: "owner", freezeId: "freeze", evidenceId: "evidence", now: 3 }); return model; }
function freshRetry(model, clock) {
  clock.value = Math.max(clock.value, model.gate().last_time) + 1;
  if (model.gate().freeze_id !== null) model.release(model.gate().freeze_id, clock.value++);
  model.freeze("retry-freeze", clock.value++);
  model.evidence("retry-evidence", "retry-freeze", clock.value + 100, clock.value++);
  model.acquire({ id: "retry-window", owner: "owner", freezeId: "retry-freeze", evidenceId: "retry-evidence", now: clock.value++ });
}
async function verifySuccess(result, output, windowId) {
  assert.equal(result.fixtureCompleted, true); assert.equal(result.remoteExecutionAvailable, false);
  assert.equal(result.manifest.sourceEnvironment, "local");
  const marker = JSON.parse(await readFile(path.join(output, "complete/fixture-complete.json"), "utf8"));
  assert.deepEqual({ fixtureOnly: marker.fixtureOnly, windowId: marker.windowId, remoteExecutionAvailable: marker.remoteExecutionAvailable }, { fixtureOnly: true, windowId, remoteExecutionAvailable: false });
  assert.equal(marker.manifestSha256, createHash("sha256").update(await readFile(path.join(output, "complete/package/manifest.json"))).digest("hex"));
  assert.equal(await readFile(path.join(output, "complete/package/r2/media/fixture"), "utf8"), bytes);
}

test("isolated mock completes only with an uninterrupted synthetic window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-mock-")); const db = new DatabaseSync(":memory:");
  try { const model = setup(db), clock = { value: 3 }, input = options(root, model, clock); await verifySuccess(await runLocalWindowedMock(input), input.output, "window"); assert.equal(model.window("window").state, "completed"); }
  finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("fixture completion verifier rejects mismatched marker and tampered manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-marker-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), input = options(root, model, { value: 3 });
    await runLocalWindowedMock(input);
    assert.deepEqual(await verifyLocalWindowedMock({ output: input.output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }), { fixtureCompleted: true, remoteExecutionAvailable: false });
    const objectFile = path.join(input.output, "complete/package/r2/media/fixture");
    await writeFile(objectFile, "tampered");
    await assert.rejects(verifyLocalWindowedMock({ output: input.output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }));
    await writeFile(objectFile, bytes);
    const manifestFile = path.join(input.output, "complete/package/manifest.json");
    await writeFile(manifestFile, "tampered");
    await assert.rejects(verifyLocalWindowedMock({ output: input.output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }), /fixture_marker_invalid/u);
    await assert.rejects(verifyLocalWindowedMock({ output: input.output, model, windowId: "window", freezeId: "other", migrationDir: path.resolve("migrations") }), /fixture_window_not_completed/u);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const stage of stages) for (const fault of ["release", "refreeze", "expiry", "revocation", "interruption"]) {
  test(`${stage}: ${fault} removes partial output and fresh-window retry succeeds`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cg-window-mock-")); const db = new DatabaseSync(":memory:");
    try {
      const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
      await assert.rejects(runLocalWindowedMock({ ...input, afterStage: async (current) => {
        if (current !== stage) return;
        if (fault === "release") model.release("freeze", ++clock.value);
        if (fault === "refreeze") { model.release("freeze", ++clock.value); model.freeze("intervening-freeze", ++clock.value); }
        if (fault === "expiry") clock.value = 100;
        if (fault === "revocation") model.revokeEvidence("evidence", ++clock.value);
        if (fault === "interruption") throw new Error("injected_step_interruption");
      } }));
      await absent(input.output);
      assert.equal(model.window("window").state, "invalidated");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE window_id='window' AND action='completed'").get().n, 0);
      freshRetry(model, clock);
      const retry = options(root, model, clock, "retry-freeze", "retry-window");
      await verifySuccess(await runLocalWindowedMock(retry), retry.output, "retry-window");
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("release interleaves with an outstanding mock export and rejects completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-interleave-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
    let signalEntered, resume;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const paused = new Promise((resolve) => { resume = resolve; });
    const pending = runLocalWindowedMock({ ...input, adapter: { ...input.adapter, exportD1: async (file) => { await writeFile(file, "-- partial fixture\n"); signalEntered(); await paused; } } });
    await entered; model.release("freeze", ++clock.value); resume();
    await assert.rejects(pending, /window_not_held/u); await absent(input.output);
    assert.equal(model.window("window").state, "invalidated");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent use of one output path never overwrites the winning fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-output-race-"));
  const databases = [new DatabaseSync(":memory:"), new DatabaseSync(":memory:")];
  try {
    const clock = { value: 3 }, inputs = databases.map((db) => options(root, setup(db), clock));
    const results = await Promise.allSettled(inputs.map((input) => runLocalWindowedMock(input)));
    const success = results.filter((item) => item.status === "fulfilled");
    const failure = results.filter((item) => item.status === "rejected");
    assert.equal(success.length, 1); assert.equal(failure.length, 1);
    assert.equal(failure[0].reason.code, "EEXIST");
    await verifySuccess(success[0].value, inputs[0].output, "window");
  } finally { databases.forEach((db) => db.close()); await rm(root, { recursive: true, force: true }); }
});

test("partial download failure removes output; existing directories are never removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-mock-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
    await assert.rejects(runLocalWindowedMock({ ...input, adapter: { ...input.adapter, downloadObject: async (_key, file) => { await writeFile(file, "partial"); throw new Error("download_failed"); } } }), /download_failed/u);
    await absent(input.output); assert.equal(model.window("window").state, "invalidated");
    freshRetry(model, clock); const retry = options(root, model, clock, "retry-freeze", "retry-window");
    await mkdir(retry.output); await writeFile(path.join(retry.output, "keep"), "untouched");
    await assert.rejects(runLocalWindowedMock(retry), { code: "EEXIST" });
    assert.equal(model.window("retry-window").state, "held");
    assert.equal(await readFile(path.join(retry.output, "keep"), "utf8"), "untouched");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("wrong owner cannot invalidate another holder or retain output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-owner-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), input = options(root, model, { value: 3 });
    await assert.rejects(runLocalWindowedMock({ ...input, owner: "other" }), /owner_mismatch/u);
    await absent(input.output); assert.equal(model.window("window").state, "held");
    await verifySuccess(await runLocalWindowedMock(input), input.output, "window");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("failure after rename before commit rolls back completion and cleans owned output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-rename-fail-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
    await assert.rejects(runLocalWindowedMock({ ...input, afterRenameBeforeCommit: () => { throw new Error("rename_commit_failure"); } }), /rename_commit_failure/u);
    assert.equal(model.window("window").state, "invalidated"); await absent(input.output);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fixture_window_audit WHERE action = 'completed'").get().n, 0);
    freshRetry(model, clock); const retry = options(root, model, clock, "retry-freeze", "retry-window");
    await verifySuccess(await runLocalWindowedMock(retry), retry.output, "retry-window");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("failure before marker invalidates the held window and removes output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-mock-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
    await assert.rejects(runLocalWindowedMock({ ...input, afterRunBeforeMarker: async () => { throw new Error("marker_failure"); } }), /marker_failure/u);
    await absent(input.output);
    assert.equal(model.window("window").state, "invalidated");
    freshRetry(model, clock); const retry = options(root, model, clock, "retry-freeze", "retry-window");
    await verifySuccess(await runLocalWindowedMock(retry), retry.output, "retry-window");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const fault of ["release", "refreeze", "expiry", "revocation", "interruption"]) {
  test(`final publication boundary: ${fault} prevents published completion`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cg-window-before-publish-")); const db = new DatabaseSync(":memory:");
    try {
      const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
      await assert.rejects(runLocalWindowedMock({ ...input, beforePublish: async () => {
        if (fault === "release") model.release("freeze", ++clock.value);
        if (fault === "refreeze") { model.release("freeze", ++clock.value); model.freeze("intervening-freeze", ++clock.value); }
        if (fault === "expiry") clock.value = 100;
        if (fault === "revocation") model.revokeEvidence("evidence", ++clock.value);
        if (fault === "interruption") throw new Error("injected_before_publish");
      } }));
      await absent(input.output); assert.equal(model.window("window").state, "invalidated");
      await assert.rejects(verifyLocalWindowedMock({ output: input.output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }), /fixture_window_not_completed/u);
      freshRetry(model, clock); const retry = options(root, model, clock, "retry-freeze", "retry-window");
      await verifySuccess(await runLocalWindowedMock(retry), retry.output, "retry-window");
      assert.deepEqual(await verifyLocalWindowedMock({ output: retry.output, model, windowId: "retry-window", freezeId: "retry-freeze", migrationDir: path.resolve("migrations") }), { fixtureCompleted: true, remoteExecutionAvailable: false });
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("post-commit failure has no valid artifact even when window history says completed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-window-postcommit-")); const db = new DatabaseSync(":memory:");
  try {
    const model = setup(db), clock = { value: 3 }, input = options(root, model, clock);
    await assert.rejects(runLocalWindowedMock({ ...input, afterPublish: async () => { throw new Error("after_publish_failure"); } }), /after_publish_failure/u);
    assert.equal(model.window("window").state, "completed"); await absent(input.output);
    await assert.rejects(verifyLocalWindowedMock({ output: input.output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }), { code: "ENOENT" });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const stopStage of ["d1_export", "verify", "finalize", "before_publish", "after_rename_before_commit", "after_publish"]) {
  test(`SIGKILL after ${stopStage}: preserve publication boundary and safely retry`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cg-window-kill-")); const dbFile = path.join(root, "fixture.sqlite"); const output = path.join(root, "attempt");
    let db = new DatabaseSync(dbFile); setup(db); db.close(); db = undefined;
    const child = spawn(process.execPath, [path.resolve("scripts/local-windowed-mock-child.mjs"), dbFile, output, stopStage], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      let observed = false;
      for (let i = 0; i < 400; i += 1) { if (stdout.includes(`checkpoint:${stopStage}\n`)) { observed = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      assert.equal(observed, true, `missing checkpoint: ${stderr}`);
      if (stopStage === "after_rename_before_commit") {
        const contender = spawn(process.execPath, [path.resolve("scripts/local-window-release-child.mjs"), dbFile], { stdio: ["ignore", "pipe", "pipe"] });
        let result = ""; contender.stdout.on("data", (chunk) => { result += chunk.toString(); });
        const exit = await new Promise((resolve, reject) => { contender.once("error", reject); contender.once("close", resolve); });
        assert.equal(exit, 0); assert.match(result, /rejected:.*(?:locked|busy)/iu);
      }
      child.kill("SIGKILL"); assert.equal((await closed).signal, "SIGKILL");
      await access(output);
      db = new DatabaseSync(dbFile); const model = new LocalBackupWindowFixture(db); model.restart();
      if (stopStage === "after_publish") {
        // A committed fixture may survive a lost acknowledgement. Inspect it;
        // never delete it or retry over the existing output path.
        assert.equal(model.window("window").state, "completed");
        const marker = JSON.parse(await readFile(path.join(output, "complete/fixture-complete.json"), "utf8"));
        assert.equal(marker.remoteExecutionAvailable, false);
        assert.equal(marker.manifestSha256, createHash("sha256").update(await readFile(path.join(output, "complete/package/manifest.json"))).digest("hex"));
        assert.deepEqual(await verifyLocalWindowedMock({ output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }), { fixtureCompleted: true, remoteExecutionAvailable: false });
        await assert.rejects(runLocalWindowedMock(options(root, model, { value: 3 })), { code: "EEXIST" });
        await access(path.join(output, "complete/fixture-complete.json"));
      } else {
        if (stopStage === "after_rename_before_commit") {
          // The directory and marker exist but SQLite rolled back. Neither the
          // file marker alone nor the orphan is accepted as completion.
          await access(path.join(output, "complete/fixture-complete.json"));
          assert.equal(model.window("window").state, "invalidated");
          await assert.rejects(verifyLocalWindowedMock({ output, model, windowId: "window", freezeId: "freeze", migrationDir: path.resolve("migrations") }), /fixture_window_not_completed/u);
        } else {
          await absent(path.join(output, "complete"));
          if (stopStage !== "d1_export") await access(path.join(output, ".fixture-staging/package/manifest.json"));
          if (stopStage === "before_publish") await access(path.join(output, ".fixture-staging/fixture-complete.json"));
          assert.equal(model.window("window").state, "invalidated");
        }
        // Only the test-owned isolated root is eligible for this cleanup.
        await rm(output, { recursive: true, force: true }); await absent(output);
      }
      const clock = { value: 3 }; freshRetry(model, clock);
      const retry = { ...options(root, model, clock, "retry-freeze", "retry-window"), output: stopStage === "after_publish" ? path.join(root, "retry") : output };
      await verifySuccess(await runLocalWindowedMock(retry), retry.output, "retry-window");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
      if (db) db.close(); await rm(root, { recursive: true, force: true });
    }
  });
}

test("remote backup CLI remains explicitly disabled", async () => {
  // Force synchronous output in the subprocess: this sandbox can drop an
  // asynchronous console.error when a short-lived child exits immediately.
  const probe = `import { writeSync } from 'node:fs'; import { pathToFileURL } from 'node:url'; console.error = (...args) => writeSync(2, args.join(' ')); await import(pathToFileURL(process.argv[1]).href);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe, path.resolve("scripts/execute-preview-remote-backup.mjs")], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(status, 1); assert.match(stderr, /Remote execution is unavailable/u);
});
