#!/usr/bin/env node
/* global console, process */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function usage() { console.error("Usage: backup-local-archive.mjs --package <verified-package-dir> --migration-dir <migration-dir> --destination <existing-local-dir> --backup-id <safe-id> --passphrase-file <mode-0600-file>"); }
function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || value === undefined || values.has(key)) throw new Error(`Invalid argument near ${key ?? "end"}.`); values.set(key, value); }
  const names = ["package", "migration-dir", "destination", "backup-id", "passphrase-file"];
  if (values.size !== names.length || names.some((name) => !values.get(`--${name}`))) throw new Error("Expected exactly --package, --migration-dir, --destination, --backup-id and --passphrase-file.");
  const backupId = values.get("--backup-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/u.test(backupId)) throw new Error("backup-id must be a safe filename component.");
  return { packageDir: path.resolve(values.get("--package")), migrationDir: path.resolve(values.get("--migration-dir")), destination: path.resolve(values.get("--destination")), backupId, passphraseFile: path.resolve(values.get("--passphrase-file")) };
}
async function regularDirectory(directory, label) { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory.`); }
async function absent(file) { try { await lstat(file); throw new Error(`Refusing to overwrite ${file}.`); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; } }
async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

try {
  const input = parseArgs(process.argv.slice(2));
  await regularDirectory(input.packageDir, "package"); await regularDirectory(input.migrationDir, "migration-dir"); await regularDirectory(input.destination, "destination");
  const encrypted = path.join(input.destination, `${input.backupId}.tar.gz.cgbk`);
  await absent(encrypted);
  await run(process.execPath, [path.join(import.meta.dirname, "backup-package.mjs"), "verify", "--package", input.packageDir, "--migration-dir", input.migrationDir], { stdio: "ignore" });
  const plaintext = path.join(input.destination, `.${input.backupId}.${process.pid}.${randomBytes(6).toString("hex")}.tar.gz`);
  try {
    await run("tar", ["--create", "--gzip", "--file", plaintext, "--directory", path.dirname(input.packageDir), path.basename(input.packageDir)], { stdio: "ignore" });
    await run(process.execPath, [path.join(import.meta.dirname, "backup-crypt.mjs"), "encrypt", "--input", plaintext, "--output", encrypted, "--passphrase-file", input.passphraseFile], { stdio: "ignore" });
  } finally { await unlink(plaintext).catch(() => undefined); }
  console.log(JSON.stringify({ ok: true, storage: "local_machine", backupId: input.backupId, encryptedArchive: encrypted, sha256: await sha256(encrypted) }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); usage(); process.exitCode = 1; }
