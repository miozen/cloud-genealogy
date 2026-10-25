#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const formatVersion = 1;

function usage() {
  console.error("Usage: backup-package.mjs create --package <dir> --migration-dir <dir> --source-environment <local|preview|production> --git-commit <sha> --count <name=value> [--count <name=value>] [--encryption-scheme <name>]\n       backup-package.mjs verify --package <dir> --migration-dir <dir>");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    const name = key.slice(2);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { command, values };
}

function one(values, name, required = true) {
  const items = values.get(name) ?? [];
  if (required && items.length !== 1) throw new Error(`Expected exactly one --${name}.`);
  if (!required && items.length > 1) throw new Error(`Expected at most one --${name}.`);
  return items[0];
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function relativePackagePath(value) {
  const normalized = value.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`Unsafe package path: ${value}`);
  return normalized;
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(relativePackagePath(path.relative(root, absolute)));
    else throw new Error(`Backup package contains a non-regular file: ${absolute}`);
  }
  return files.sort();
}

async function describeFile(root, relativePath) {
  const absolute = path.join(root, relativePath);
  const contents = await readFile(absolute);
  const info = await stat(absolute);
  return {
    path: relativePath,
    kind: relativePath === "d1/schema-and-data.sql" ? "d1" : "r2",
    ...(relativePath.startsWith("r2/") ? { objectKey: relativePath.slice(3) } : {}),
    bytes: info.size,
    sha256: sha256(contents),
  };
}

async function migrationBaseline(migrationDir) {
  const files = (await readdir(migrationDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error("Migration directory contains no .sql files.");
  return Promise.all(files.map(async (file) => ({ path: `migrations/${file}`, sha256: sha256(await readFile(path.join(migrationDir, file))) })));
}

function parseCounts(values) {
  const counts = {};
  for (const value of values.get("count") ?? []) {
    const [name, raw] = value.split("=", 2);
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name) || raw === undefined || !/^\d+$/.test(raw)) throw new Error(`Invalid --count value: ${value}`);
    if (Object.hasOwn(counts, name)) throw new Error(`Duplicate count name: ${name}`);
    counts[name] = Number(raw);
  }
  if (Object.keys(counts).length === 0) throw new Error("At least one --count is required.");
  return counts;
}

function assertManifestShape(manifest) {
  const fail = (message) => { throw new Error(`Invalid manifest: ${message}`); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("must be an object");
  if (manifest.formatVersion !== formatVersion) fail(`unsupported formatVersion ${manifest.formatVersion}`);
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) fail("createdAt must be an ISO date");
  if (!/^(local|preview|production)$/.test(manifest.sourceEnvironment)) fail("invalid sourceEnvironment");
  if (typeof manifest.gitCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(manifest.gitCommit)) fail("invalid gitCommit");
  if (!manifest.encryption || typeof manifest.encryption.scheme !== "string") fail("missing encryption scheme");
  if (manifest.sourceEnvironment !== "local" && manifest.encryption.scheme === "none") fail("non-local package must declare encryption");
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) fail("missing migration baseline");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("missing files");
  if (!manifest.counts || typeof manifest.counts !== "object" || Array.isArray(manifest.counts) || Object.keys(manifest.counts).length === 0) fail("missing counts");
  for (const [name, value] of Object.entries(manifest.counts)) if (!/^[a-z][a-z0-9_]*$/.test(name) || !Number.isSafeInteger(value) || value < 0) fail(`invalid count ${name}`);
  const seen = new Set();
  let hasD1 = false;
  for (const file of manifest.files) {
    if (!file || typeof file !== "object") fail("file entry must be an object");
    const filePath = relativePackagePath(file.path);
    if (seen.has(filePath)) fail(`duplicate file ${filePath}`);
    seen.add(filePath);
    if (!/^[0-9a-f]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail(`invalid integrity metadata for ${filePath}`);
    if (file.kind === "d1") {
      if (filePath !== "d1/schema-and-data.sql") fail("D1 export path must be d1/schema-and-data.sql");
      hasD1 = true;
    } else if (file.kind === "r2") {
      if (!filePath.startsWith("r2/") || typeof file.objectKey !== "string" || !file.objectKey || file.objectKey.startsWith("/")) fail(`invalid R2 object ${filePath}`);
    } else fail(`unknown file kind for ${filePath}`);
  }
  if (!hasD1) fail("missing D1 export");
  for (const migration of manifest.migrations) if (!migration || !/^migrations\/[^/]+\.sql$/.test(migration.path) || !/^[0-9a-f]{64}$/i.test(migration.sha256)) fail("invalid migration baseline");
}

async function createPackage(values) {
  const packageDir = path.resolve(one(values, "package"));
  const migrationDir = path.resolve(one(values, "migration-dir"));
  const sourceEnvironment = one(values, "source-environment");
  const gitCommit = one(values, "git-commit");
  const encryptionScheme = one(values, "encryption-scheme", false) ?? "none";
  const packageFiles = (await listFiles(packageDir)).filter((file) => file !== "manifest.json");
  const manifest = {
    formatVersion,
    createdAt: new Date().toISOString(),
    sourceEnvironment,
    gitCommit,
    consistencyMode: sourceEnvironment === "local" ? "local_fixture" : "logical_write_freeze",
    encryption: { scheme: encryptionScheme },
    migrations: await migrationBaseline(migrationDir),
    counts: parseCounts(values),
    files: await Promise.all(packageFiles.map((file) => describeFile(packageDir, file))),
  };
  assertManifestShape(manifest);
  await writeFile(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ ok: true, manifest: "manifest.json", fileCount: manifest.files.length }, null, 2));
}

async function verifyPackage(values) {
  const packageDir = path.resolve(one(values, "package"));
  const migrationDir = path.resolve(one(values, "migration-dir"));
  const manifest = JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8"));
  assertManifestShape(manifest);
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = new Set((await listFiles(packageDir)).filter((file) => file !== "manifest.json"));
  if (manifestPaths.size !== actualPaths.size || [...manifestPaths].some((file) => !actualPaths.has(file))) throw new Error("Package files do not exactly match manifest.");
  for (const file of manifest.files) {
    const described = await describeFile(packageDir, file.path);
    if (described.bytes !== file.bytes || described.sha256 !== file.sha256 || described.kind !== file.kind || described.objectKey !== file.objectKey) throw new Error(`Integrity check failed for ${file.path}`);
  }
  const actualMigrations = await migrationBaseline(migrationDir);
  if (JSON.stringify(actualMigrations) !== JSON.stringify(manifest.migrations)) throw new Error("Migration baseline does not match the current repository.");
  console.log(JSON.stringify({ ok: true, formatVersion: manifest.formatVersion, sourceEnvironment: manifest.sourceEnvironment, fileCount: manifest.files.length, counts: manifest.counts }, null, 2));
}

try {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "create") await createPackage(values);
  else if (command === "verify") await verifyPackage(values);
  else { usage(); process.exitCode = 2; }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
