#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const formatVersion = 2;

function usage() {
  console.error("Usage: backup-package.mjs create --package <dir> --migration-dir <dir> --source-environment <local|preview|production> --git-commit <sha> (--counts-file <counts.json> | --count <name=value> [--count <name=value>]) [--encryption-scheme <name>]\n       backup-package.mjs verify --package <dir> --migration-dir <dir>");
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

async function describeFile(root, relativePath, sourceEnvironment, mediaAssetsByObjectKey) {
  const absolute = path.join(root, relativePath);
  const contents = await readFile(absolute);
  const info = await stat(absolute);
  const objectKey = relativePath.startsWith("r2/") ? relativePath.slice(3) : null;
  const mediaAsset = objectKey ? mediaAssetsByObjectKey.get(objectKey) : null;
  if (objectKey && !mediaAsset) throw new Error(`R2 object is not present in the media inventory: ${objectKey}`);
  return {
    path: relativePath,
    kind: relativePath === "d1/schema-and-data.sql" ? "d1" : "r2",
    ...(objectKey ? { objectKey, mediaAssetId: mediaAsset.mediaAssetId, mimeType: mediaAsset.mimeType, ...(sourceEnvironment === "local" ? { referenceKind: "local_fixture" } : {}) } : {}),
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

function validateCounts(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new Error("Counts must be an object.");
  const normalized = {};
  for (const [name, value] of Object.entries(counts)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid count ${name}.`);
    normalized[name] = value;
  }
  if (Object.keys(normalized).length === 0) throw new Error("At least one count is required.");
  return normalized;
}

function validateMediaAssets(mediaAssets) {
  if (!Array.isArray(mediaAssets)) throw new Error("Media assets must be an array.");
  const ids = new Set(); const keys = new Set();
  return mediaAssets.map((asset) => {
    if (!asset || typeof asset !== "object" || !/^[0-9a-f-]{36}$/i.test(asset.mediaAssetId) || typeof asset.objectKey !== "string" || !asset.objectKey.startsWith("media/") || asset.objectKey.split("/").some((part) => !part || part === "." || part === "..") || !/^[0-9a-f]{64}$/i.test(asset.sha256) || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1 || !["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType) || !["active", "retired"].includes(asset.state) || !Number.isSafeInteger(asset.activeReferenceCount) || asset.activeReferenceCount < 0) throw new Error("Invalid media asset inventory entry.");
    if (ids.has(asset.mediaAssetId) || keys.has(asset.objectKey)) throw new Error("Duplicate media asset inventory entry.");
    ids.add(asset.mediaAssetId); keys.add(asset.objectKey);
    return asset;
  });
}

async function parseCounts(values) {
  const countsFile = one(values, "counts-file", false);
  if (countsFile && (values.get("count") ?? []).length > 0) throw new Error("Use either --counts-file or --count, not both.");
  if (countsFile) {
    const payload = JSON.parse(await readFile(path.resolve(countsFile), "utf8"));
    if (payload?.formatVersion !== 2 || payload?.source !== "local_d1") throw new Error("Counts file must be produced by the local D1 count collector.");
    return { counts: validateCounts(payload.counts), mediaAssets: validateMediaAssets(payload.mediaAssets) };
  }
  const counts = {};
  for (const value of values.get("count") ?? []) {
    const [name, raw] = value.split("=", 2);
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name) || raw === undefined || !/^\d+$/.test(raw)) throw new Error(`Invalid --count value: ${value}`);
    if (Object.hasOwn(counts, name)) throw new Error(`Duplicate count name: ${name}`);
    counts[name] = Number(raw);
  }
  return { counts: validateCounts(counts), mediaAssets: [] };
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
  let mediaAssets;
  try { mediaAssets = validateMediaAssets(manifest.mediaAssets); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  const mediaByObjectKey = new Map(mediaAssets.map((asset) => [asset.objectKey, asset]));
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
      if (manifest.sourceEnvironment === "local" && file.referenceKind !== "local_fixture") fail(`local R2 object must be marked fixture-only: ${filePath}`);
      const mediaAsset = mediaByObjectKey.get(file.objectKey);
      if (!mediaAsset || file.mediaAssetId !== mediaAsset.mediaAssetId || file.mimeType !== mediaAsset.mimeType || file.sha256 !== mediaAsset.sha256 || file.bytes !== mediaAsset.byteSize) fail(`R2 object does not match media inventory: ${filePath}`);
    } else fail(`unknown file kind for ${filePath}`);
  }
  if (!hasD1) fail("missing D1 export");
  if ([...mediaByObjectKey.keys()].some((objectKey) => !seen.has(`r2/${objectKey}`))) fail("media inventory has no matching R2 object");
  for (const migration of manifest.migrations) if (!migration || !/^migrations\/[^/]+\.sql$/.test(migration.path) || !/^[0-9a-f]{64}$/i.test(migration.sha256)) fail("invalid migration baseline");
}

async function createPackage(values) {
  const packageDir = path.resolve(one(values, "package"));
  const migrationDir = path.resolve(one(values, "migration-dir"));
  const sourceEnvironment = one(values, "source-environment");
  const gitCommit = one(values, "git-commit");
  const encryptionScheme = one(values, "encryption-scheme", false) ?? "none";
  const packageFiles = (await listFiles(packageDir)).filter((file) => file !== "manifest.json");
  const inventory = await parseCounts(values);
  const mediaAssetsByObjectKey = new Map(inventory.mediaAssets.map((asset) => [asset.objectKey, asset]));
  const manifest = {
    formatVersion,
    createdAt: new Date().toISOString(),
    sourceEnvironment,
    gitCommit,
    consistencyMode: sourceEnvironment === "local" ? "local_fixture" : "logical_write_freeze",
    encryption: { scheme: encryptionScheme },
    migrations: await migrationBaseline(migrationDir),
    counts: inventory.counts,
    mediaAssets: inventory.mediaAssets,
    files: await Promise.all(packageFiles.map((file) => describeFile(packageDir, file, sourceEnvironment, mediaAssetsByObjectKey))),
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
    const described = await describeFile(packageDir, file.path, manifest.sourceEnvironment, new Map((manifest.mediaAssets ?? []).map((asset) => [asset.objectKey, asset])));
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
