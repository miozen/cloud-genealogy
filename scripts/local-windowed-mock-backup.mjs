/* global process */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runMockBackup } from "./execute-preview-remote-backup.mjs";
const execute = promisify(execFile);

// Test-only orchestration. A constructed fixture, not a remote backup API.
// Model evidence and timestamps are synthetic and cannot authorize anything.
export async function runLocalWindowedMock({ output, migrationDir, gitCommit, adapter, freezeId, model, windowId, owner, now, afterStage = async () => {}, afterRunBeforeMarker = async () => {}, beforePublish = async () => {}, afterRenameBeforeCommit = () => {}, afterPublish = async () => {} }) {
  if (!path.isAbsolute(output)) throw new Error("Absolute paths required.");
  // Exclusive reservation occurs outside the cleanup scope: an existing
  // directory always belongs to someone else and must never be removed.
  await mkdir(output, { mode: 0o700 });
  const staging = path.join(output, ".fixture-staging");
  const invalidateOwned = () => {
    const current = model.window(windowId);
    if (current?.state === "held" && current.owner === owner) model.restart();
  };
  try {
    const manifest = await runMockBackup({ output: staging, migrationDir, gitCommit, adapter, freezeId,
      fixtureStage: async (name, operation) => {
        model.startStep(windowId, owner, name, now());
        const result = await operation();
        await afterStage(name);
        model.finishStep(windowId, owner, name, now());
        return result;
      },
    });
    await afterRunBeforeMarker();
    const hash = createHash("sha256").update(await readFile(path.join(staging, "package", "manifest.json"))).digest("hex");
    const epoch = model.window(windowId)?.epoch;
    await writeFile(path.join(staging, "fixture-complete.json"), JSON.stringify({ fixtureOnly: true, windowId, freezeId, epoch, manifestSha256: hash, remoteExecutionAvailable: false }), { flag: "wx", mode: 0o600 });
    await beforePublish();
    // The output directory is owned exclusively by this fixture. Hold the
    // local SQLite write transaction across the synchronous filesystem rename
    // so a concurrent fixture release cannot pass the final validation.
    // A crash can still split filesystem and SQLite; readers must check both.
    const published = path.join(output, "complete");
    model.finishWindow(windowId, owner, now(), () => {
      renameSync(staging, published);
      afterRenameBeforeCommit();
    });
    await afterPublish();
    return { manifest, fixturePath: published, fixtureCompleted: true, remoteExecutionAvailable: false };
  } catch (error) {
    invalidateOwned();
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

/** Fixture-only read check: a manifest or marker alone is not completion. */
export async function verifyLocalWindowedMock({ output, model, windowId, freezeId, migrationDir }) {
  if (!path.isAbsolute(output) || !path.isAbsolute(migrationDir)) throw new Error("Absolute paths required.");
  const window = model.window(windowId);
  if (!window || window.state !== "completed" || window.freeze_id !== freezeId) throw new Error("fixture_window_not_completed");
  const root = path.join(output, "complete");
  const marker = JSON.parse(await readFile(path.join(root, "fixture-complete.json"), "utf8"));
  const hash = createHash("sha256").update(await readFile(path.join(root, "package", "manifest.json"))).digest("hex");
  if (marker.fixtureOnly !== true || marker.windowId !== windowId || marker.freezeId !== freezeId || marker.epoch !== window.epoch || marker.remoteExecutionAvailable !== false || marker.manifestSha256 !== hash) throw new Error("fixture_marker_invalid");
  await execute(process.execPath, [path.join(import.meta.dirname, "backup-package.mjs"), "verify", "--package", path.join(root, "package"), "--migration-dir", migrationDir]);
  return { fixtureCompleted: true, remoteExecutionAvailable: false };
}
