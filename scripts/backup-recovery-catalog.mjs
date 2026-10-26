#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() { console.error("Usage: backup-recovery-catalog.mjs register --catalog <catalog.json> --backup-id <id> --archive <encrypted.cgbk>\n       backup-recovery-catalog.mjs verify-retention --catalog <catalog.json> --minimum <positive-integer>"); }
function parse(argv) {
  const [command, ...rest] = argv; const values = new Map();
  for (let index = 0; index < rest.length; index += 2) { const key = rest[index]; const value = rest[index + 1]; if (!key?.startsWith("--") || value === undefined || values.has(key)) throw new Error(`Invalid argument near ${key ?? "end"}.`); values.set(key.slice(2), value); }
  return { command, values };
}
function backupId(value) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/u.test(value ?? "")) throw new Error("backup-id must be a safe identifier."); return value; }
async function regularFile(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Archive must be a regular non-symlink file: ${file}`); return info; }
async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function catalog(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Recovery catalog must be a regular non-symlink file."); const value = JSON.parse(await readFile(file, "utf8")); if (value?.formatVersion !== 1 || !Array.isArray(value.entries)) throw new Error("Invalid recovery catalog."); return value; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { formatVersion: 1, entries: [] }; throw error; }
}
async function save(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }

try {
  const { command, values } = parse(process.argv.slice(2));
  const catalogFile = path.resolve(values.get("catalog") ?? "");
  if (!values.get("catalog")) throw new Error("Missing --catalog.");
  if (command === "register") {
    if (values.size !== 3 || !values.get("backup-id") || !values.get("archive")) throw new Error("register requires exactly --catalog, --backup-id and --archive.");
    const id = backupId(values.get("backup-id")); const archive = path.resolve(values.get("archive")); const info = await regularFile(archive); const current = await catalog(catalogFile);
    if (current.entries.some((entry) => entry.backupId === id)) throw new Error("Backup ID is already cataloged.");
    current.entries.push({ backupId: id, archive, bytes: info.size, sha256: await digest(archive), registeredAt: new Date().toISOString() });
    await save(catalogFile, current); console.log(JSON.stringify({ ok: true, entryCount: current.entries.length }, null, 2));
  } else if (command === "verify-retention") {
    if (values.size !== 2 || !values.get("minimum") || !/^\d+$/u.test(values.get("minimum")) || Number(values.get("minimum")) < 1) throw new Error("verify-retention requires --catalog and positive --minimum.");
    const current = await catalog(catalogFile); const minimum = Number(values.get("minimum"));
    if (current.entries.length < minimum) throw new Error(`Recovery catalog has ${current.entries.length} entries; ${minimum} required.`);
    for (const entry of current.entries) { backupId(entry.backupId); const info = await regularFile(entry.archive); if (info.size !== entry.bytes || await digest(entry.archive) !== entry.sha256) throw new Error(`Archive integrity mismatch: ${entry.backupId}`); }
    console.log(JSON.stringify({ ok: true, entryCount: current.entries.length, minimum }, null, 2));
  } else throw new Error("Unknown command.");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); usage(); process.exitCode = 1; }
