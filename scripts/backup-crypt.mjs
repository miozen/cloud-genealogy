#!/usr/bin/env node
/* global Buffer, console, process */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { appendFile, lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("CGBKENC1", "ascii");
const authTagBytes = 16;
const scryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function usage() {
  console.error("Usage: backup-crypt.mjs <encrypt|decrypt> --input <file> --output <new-file> --passphrase-file <mode-0600-file>");
}

function parseArgs(argv) {
  const [operation, ...rest] = argv;
  if (operation !== "encrypt" && operation !== "decrypt") throw new Error("Operation must be encrypt or decrypt.");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`Duplicate --${name}.`);
    values.set(name, value);
  }
  for (const name of ["input", "output", "passphrase-file"]) if (!values.get(name)) throw new Error(`Missing --${name}.`);
  if (values.size !== 3) throw new Error("Only --input, --output and --passphrase-file are accepted.");
  return { operation, input: path.resolve(values.get("input")), output: path.resolve(values.get("output")), passphraseFile: path.resolve(values.get("passphrase-file")) };
}

async function readPassphrase(file) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("Passphrase path must be a regular file.");
  if ((info.mode & 0o077) !== 0) throw new Error("Passphrase file must not be readable by group or others (chmod 600).");
  const contents = await readFile(file);
  const passphrase = contents.subarray(0, contents.length > 0 && contents.at(-1) === 10 ? contents.length - 1 : contents.length);
  if (passphrase.length < 16) throw new Error("Passphrase must contain at least 16 bytes.");
  return passphrase;
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, scryptOptions);
}

async function ensureOutputAbsent(output) {
  try {
    await lstat(output);
    throw new Error("Refusing to overwrite output file.");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function tempPath(output) {
  return `${output}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

async function encrypt(input, output, passphrase) {
  await ensureOutputAbsent(output);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ formatVersion: 1, cipher: "aes-256-gcm", kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64") }), "utf8");
  if (header.length > 65_535) throw new Error("Encryption header is unexpectedly large.");
  const prefix = Buffer.alloc(magic.length + 4);
  magic.copy(prefix);
  prefix.writeUInt32BE(header.length, magic.length);
  const temporary = tempPath(output);
  const key = deriveKey(passphrase, salt);
  try {
    await writeFile(temporary, Buffer.concat([prefix, header]), { flag: "wx", mode: 0o600 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    await pipeline(createReadStream(input), cipher, createWriteStream(temporary, { flags: "a", mode: 0o600 }));
    await appendFile(temporary, cipher.getAuthTag());
    await rename(temporary, output);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

async function readEnvelope(input) {
  const info = await lstat(input);
  if (!info.isFile() || info.size < magic.length + 4 + authTagBytes) throw new Error("Encrypted backup is too small.");
  const file = await open(input, "r");
  try {
    const prefix = Buffer.alloc(magic.length + 4);
    await file.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, magic.length).equals(magic)) throw new Error("Encrypted backup has an unknown format.");
    const headerLength = prefix.readUInt32BE(magic.length);
    if (headerLength === 0 || headerLength > 65_535 || info.size < prefix.length + headerLength + authTagBytes) throw new Error("Encrypted backup has an invalid header.");
    const headerBytes = Buffer.alloc(headerLength);
    await file.read(headerBytes, 0, headerLength, prefix.length);
    const header = JSON.parse(headerBytes.toString("utf8"));
    if (header?.formatVersion !== 1 || header?.cipher !== "aes-256-gcm" || header?.kdf !== "scrypt" || typeof header.salt !== "string" || typeof header.iv !== "string") throw new Error("Encrypted backup uses an unsupported header.");
    const salt = Buffer.from(header.salt, "base64");
    const iv = Buffer.from(header.iv, "base64");
    if (salt.length !== 16 || iv.length !== 12) throw new Error("Encrypted backup has invalid key material metadata.");
    const authTag = Buffer.alloc(authTagBytes);
    await file.read(authTag, 0, authTagBytes, info.size - authTagBytes);
    return { salt, iv, authTag, ciphertextStart: prefix.length + headerLength, ciphertextEnd: info.size - authTagBytes - 1 };
  } finally {
    await file.close();
  }
}

async function decrypt(input, output, passphrase) {
  await ensureOutputAbsent(output);
  const envelope = await readEnvelope(input);
  const temporary = tempPath(output);
  const key = deriveKey(passphrase, envelope.salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
    decipher.setAuthTag(envelope.authTag);
    await pipeline(createReadStream(input, { start: envelope.ciphertextStart, end: envelope.ciphertextEnd }), decipher, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await rename(temporary, output);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new Error("Backup authentication failed; no output was created.", { cause: error });
  } finally {
    key.fill(0);
  }
}

try {
  const command = parseArgs(process.argv.slice(2));
  const passphrase = await readPassphrase(command.passphraseFile);
  try {
    if (command.operation === "encrypt") await encrypt(command.input, command.output, passphrase);
    else await decrypt(command.input, command.output, passphrase);
  } finally {
    passphrase.fill(0);
  }
  console.log(JSON.stringify({ ok: true, operation: command.operation, output: command.output }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
