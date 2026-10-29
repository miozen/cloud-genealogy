/* global process, console, fetch, setTimeout */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRecoveryFixtureSchema, recoverLocalAdmission } from "./local-admission-recovery-fixture.mjs";

// Owns one isolated local Worker and its process group, never any remote DB.
const root = await mkdtemp(path.join(tmpdir(), "cg-auth-crash-"));
const state = path.join(root, "state");
const config = path.join(root, "config");
const port = Number(process.env.LOCAL_CRASH_TEST_PORT ?? 19002);
const base = `http://127.0.0.1:${port}`;
const wrangler = path.resolve("node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, XDG_CONFIG_HOME: config, WRANGLER_SEND_METRICS: "false" };
const args = ["dev", "tests/fixtures/fencing-barrier-worker.ts", "--local", "--port", String(port), "--persist-to", state,
  "--var", "AUTH_RATE_LIMIT_SECRET:local-crash-rate-limit-secret", "--var", "BOOTSTRAP_SECRET:local-crash-bootstrap-secret"];
let worker; let exited; let workerLog = ""; let db;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function groupHasLiveMembers(groupId) {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === groupId && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return false;
}
async function startWorker() {
  worker = spawn(process.execPath, [wrangler, ...args], { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerLog += chunk.toString(); });
  worker.stderr.on("data", (chunk) => { workerLog += chunk.toString(); });
  exited = new Promise((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`local Worker exited: ${workerLog}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`local Worker startup timeout: ${workerLog}`);
}
async function stopWorker() {
  if (!worker) return;
  const id = worker.pid;
  try { process.kill(-id, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const result = await exited;
  for (let attempt = 0; attempt < 100 && await groupHasLiveMembers(id); attempt += 1) await delay(50);
  assert.equal(await groupHasLiveMembers(id), false, "all owned Worker processes must stop");
  worker = undefined;
  return result;
}
async function api(route, { body, cookie, csrf, secret, gate } = {}) {
  const response = await fetch(`${base}${route}`, { method: body ? "POST" : "GET", headers: {
    ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}),
    ...(csrf ? { "x-csrf-token": csrf } : {}), ...(secret ? { "x-bootstrap-secret": secret } : {}),
    ...(gate ? { "x-test-fencing-gate": gate } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}
async function findDatabase(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith(".sqlite")) found.push(next);
    }
  }
  await walk(path.join(dir, "v3", "d1"));
  const d1Files = found.filter((file) => path.basename(file) !== "metadata.sqlite");
  assert.equal(d1Files.length, 1, "isolated fixture must contain exactly one D1 SQLite database");
  return d1Files[0];
}
try {
  execFileSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state], { env, stdio: "pipe" });
  await startWorker();
  const password = "local-crash-fixture-password";
  assert.equal((await api("/api/setup/bootstrap", { secret: "local-crash-bootstrap-secret", body: { username: "crash.admin", password, genealogyName: "隔离测试管理员" } })).response.status, 201);
  const login = await api("/api/auth/login", { body: { username: "crash.admin", password } });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.getSetCookie().find((value) => value.startsWith("cg_session=")).split(";", 1)[0];
  const csrf = login.body.csrfToken;
  const gate = randomUUID();
  const interrupted = api("/api/auth/register", { gate, body: { username: "crash.pending", password, genealogyName: "中断测试" } }).catch(() => null);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await api(`/api/__test/fencing/${gate}`)).body.ready) { ready = true; break; }
    await delay(50);
  }
  assert.equal(ready, true, "request must be admitted and stopped before its D1 transaction");
  const freeze = await api("/api/admin/backup-write-freeze", { cookie, csrf, body: { reason: "本地中断与恢复测试" } });
  assert.equal(freeze.response.status, 201);
  const blockers = await api("/api/admin/backup-write-freeze/blockers", { cookie });
  assert.equal(blockers.body.admissions.length, 1);
  assert.equal(blockers.body.recoveryAvailable, false);
  const admissionId = blockers.body.admissions[0].id;
  const dbPath = await findDatabase(state);
  // The live process group is not proof of a terminated request; no recovery.
  assert.equal(await groupHasLiveMembers(worker.pid), true);
  assert.throws(() => recoverLocalAdmission(null, { stopped: () => worker === undefined, reason: "live" }), /worker_group_still_running/u);
  const crashedGroupId = worker.pid;
  const crashed = await stopWorker();
  assert.equal(crashed.signal, "SIGKILL");
  await interrupted;
  await startWorker();
  const afterRestart = await api("/api/admin/backup-write-freeze/readiness", { cookie });
  assert.equal(afterRestart.body.activeWrites, 1);
  assert.equal(afterRestart.body.apiWritesDrained, false);
  assert.equal(afterRestart.body.remoteExecutionAvailable, false);
  const blockersAfter = await api("/api/admin/backup-write-freeze/blockers", { cookie });
  assert.equal(blockersAfter.body.admissions[0].id, admissionId);
  assert.throws(() => recoverLocalAdmission(null, { stopped: () => worker === undefined, reason: "restart alive" }), /worker_group_still_running/u);
  await stopWorker();
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account WHERE username = 'crash.pending'").get().n, 0);
  const actorId = db.prepare("SELECT id FROM account WHERE username = 'crash.admin'").get().id;
  const reviewerId = randomUUID();
  const fixtureTime = new Date().toISOString();
  db.prepare("INSERT INTO account (id, username, display_name, password_scheme, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(reviewerId, "fixture.reviewer", "测试复核人", "fixture", "fixture", fixtureTime, fixtureTime);
  db.prepare("INSERT INTO account_role (account_id, role_id, granted_at, granted_by_account_id) VALUES (?, 'role-admin', ?, ?)").run(reviewerId, fixtureTime, actorId);
  createRecoveryFixtureSchema(db);
  const fixture = { requestId: randomUUID(), admissionId, freezeId: freeze.body.freeze.id, actorId, reviewerId, stopped: () => worker === undefined, reason: "隔离进程组已终止", evidence: { kind: "isolated_process_group_stopped", supervisorId: "isolated-local-test", processGroupId: crashedGroupId, observedAt: fixtureTime } };
  const currentId = randomUUID();
  db.prepare("INSERT INTO backup_write_admission (id, admitted_at, epoch) SELECT ?, ?, epoch FROM backup_write_epoch WHERE id = 1").run(currentId, new Date().toISOString());
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, admissionId: currentId }), /admission_not_fenced/u);
  db.prepare("UPDATE backup_write_admission SET completed_at = ? WHERE id = ?").run(new Date().toISOString(), currentId);
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, freezeId: randomUUID() }), /active_freeze_or_open_admission_missing/u);
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, reviewerId: actorId }), /two_distinct_approvers_required/u);
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, reviewerId: randomUUID() }), /approver_not_active_admin/u);
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, evidence: { kind: "unsupported" } }), /recovery_evidence_invalid/u);
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, injectAuditFailure: true }), /injected_recovery_failure/u);
  assert.equal(db.prepare("SELECT completed_at FROM backup_write_admission WHERE id = ?").get(admissionId).completed_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_fixture_admission_recovery").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.local_fixture_admission_recovered'").get().n, 0);
  db.close(); db = undefined;

  // Kill an isolated SQLite writer before COMMIT, then after COMMIT but before
  // acknowledgement. This tests transaction boundaries, not Cloudflare D1.
  const childScript = path.resolve("scripts/local-admission-recovery-child.mjs");
  const childInput = { requestId: fixture.requestId, admissionId, freezeId: fixture.freezeId, actorId, reviewerId, reason: fixture.reason, evidence: fixture.evidence };
  async function killAt(checkpoint) {
    const child = spawn(process.execPath, [childScript, dbPath, JSON.stringify(childInput), checkpoint], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { errors += data.toString(); });
    const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    let observed = false;
    for (let i = 0; i < 300; i += 1) {
      if (output.includes(`${checkpoint}\n`)) { observed = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(50);
    }
    if (!observed) { child.kill("SIGKILL"); await closed; throw new Error(`checkpoint ${checkpoint} not reached: ${errors}`); }
    child.kill("SIGKILL");
    assert.equal((await closed).signal, "SIGKILL");
  }
  await killAt("before_commit");
  db = new DatabaseSync(dbPath); db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_fixture_admission_recovery").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.local_fixture_admission_recovered'").get().n, 0);
  db.close(); db = undefined;
  await killAt("after_commit");
  db = new DatabaseSync(dbPath); db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  assert.deepEqual(recoverLocalAdmission(db, fixture), { state: "recovered", alreadyApplied: true });
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, requestId: randomUUID() }), /recovery_request_conflict/u);
  assert.throws(() => recoverLocalAdmission(db, { ...fixture, evidence: { ...fixture.evidence, supervisorId: "changed" } }), /recovery_request_conflict/u);
  assert.throws(() => db.prepare("UPDATE local_fixture_admission_recovery SET reason = 'changed' WHERE admission_id = ?").run(admissionId), /recovery_record_immutable/u);
  assert.throws(() => db.prepare("DELETE FROM local_fixture_admission_recovery WHERE admission_id = ?").run(admissionId), /recovery_record_immutable/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_fixture_admission_recovery WHERE admission_id = ? AND state = 'recovered'").get(admissionId).n, 1);
  assert.equal(db.prepare("SELECT completed_at FROM backup_write_admission WHERE id = ?").get(admissionId).completed_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.local_fixture_admission_recovered' AND object_id = ?").get(admissionId).n, 1);
  const recorded = db.prepare("SELECT * FROM local_fixture_admission_recovery WHERE admission_id = ?").get(admissionId);
  const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM audit_log WHERE action = 'backup.local_fixture_admission_recovered' AND object_id = ?").get(admissionId).metadata_json);
  assert.equal(recorded.evidence_sha256, createHash("sha256").update(recorded.evidence_json).digest("hex"));
  assert.equal(metadata.evidenceSha256, recorded.evidence_sha256);
  assert.equal(metadata.reviewerId, reviewerId);

  // Two independent recovery processes race with one request and admission.
  const concurrentId = randomUUID();
  db.prepare("INSERT INTO backup_write_admission (id, admitted_at, epoch) VALUES (?, ?, ?)").run(concurrentId, fixtureTime, recorded.admission_epoch);
  const concurrentInput = { ...childInput, admissionId: concurrentId, requestId: randomUUID() };
  db.close(); db = undefined;
  const concurrentChildren = Array.from({ length: 2 }, () => spawn(process.execPath, [childScript, dbPath, JSON.stringify(concurrentInput), "none"], { stdio: ["ignore", "ignore", "pipe"] }));
  const childResults = await Promise.all(concurrentChildren.map((child) => new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  })));
  assert.deepEqual(childResults.map((result) => result.code), [0, 0], JSON.stringify(childResults));
  db = new DatabaseSync(dbPath); db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_fixture_admission_recovery WHERE admission_id = ?").get(concurrentId).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.local_fixture_admission_recovered' AND object_id = ?").get(concurrentId).n, 1);
  db.close(); db = undefined;
  await startWorker();
  const afterRecovery = await api("/api/admin/backup-write-freeze/readiness", { cookie });
  assert.equal(afterRecovery.body.activeWrites, 2);
  assert.equal(afterRecovery.body.apiWritesDrained, false);
  assert.equal(afterRecovery.body.uploadsDrained, false);
  assert.equal(afterRecovery.body.remoteExecutionAvailable, false);
  console.log("本地认证 Worker SIGKILL、独立恢复状态、提交前后中断与重试通过。");
} finally {
  if (db) db.close();
  await stopWorker();
  await rm(root, { recursive: true, force: true });
}
