/* global Buffer, process */
// Test fixture only. A hard-link publishes complete bytes without overwriting an
// existing target on the same filesystem. It is not an R2 implementation.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

function unlinkTemporary(file) { try { unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") throw error; } }

export class FileObjectStoreFixture {
  constructor(root, onPublished = () => {}) { this.root = root; this.onPublished = onPublished; }
  filename(key) {
    if (!/^published\/[1-9][0-9]*\/[a-zA-Z0-9_-]{1,80}$/u.test(key)) throw new Error("invalid fixture key");
    return path.join(this.root, ...key.split("/"));
  }
  get(key) {
    try { return readFileSync(this.filename(key)); }
    catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  }
  putIfAbsent(key, bytes) {
    const target = this.filename(key); const directory = path.dirname(target);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.fixture-${process.pid}-${randomBytes(12).toString("hex")}`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, Buffer.from(bytes)); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temporary, target); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      this.onPublished();
    } finally {
      if (fd !== undefined) closeSync(fd);
      unlinkTemporary(temporary);
    }
  }
}
