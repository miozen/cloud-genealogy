const encoder = new TextEncoder();

export const PBKDF2_SCHEME = "pbkdf2-sha256";
/**
 * This small, personally operated site uses a deliberately modest work factor.
 * Account approval, rate limiting and sessions remain in place; it is not
 * represented as OWASP-strength storage.
 */
export const PBKDF2_ITERATIONS = 10_000;

const HASH_LENGTH_BITS = 256;
const SALT_LENGTH_BYTES = 16;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

interface PasswordRecord {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;

  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function parsePasswordRecord(value: string): PasswordRecord | null {
  const parts = value.split("$");
  const [scheme, iterationsValue, saltValue, hashValue] = parts;
  if (
    parts.length !== 4 ||
    scheme !== PBKDF2_SCHEME ||
    iterationsValue === undefined ||
    saltValue === undefined ||
    hashValue === undefined
  ) {
    return null;
  }

  const iterations = Number(iterationsValue);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return null;

  const salt = fromBase64Url(saltValue);
  const hash = fromBase64Url(hashValue);
  if (salt?.byteLength !== SALT_LENGTH_BYTES || hash?.byteLength !== HASH_LENGTH_BITS / 8) return null;

  return { iterations, salt, hash };
}

function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password length is invalid.");
  }
}

async function deriveHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltCopy,
      iterations,
    },
    material,
    HASH_LENGTH_BITS,
  );

  return new Uint8Array(derived);
}

function timingSafeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.byteLength !== expected.byteLength) return false;

  let difference = 0;
  for (let index = 0; index < actual.byteLength; index += 1) {
    difference |= actual[index]! ^ expected[index]!;
  }
  return difference === 0;
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  validatePassword(password);
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("PBKDF2 iterations are invalid.");

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const hash = await deriveHash(password, salt, iterations);

  return `${PBKDF2_SCHEME}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, storedRecord: string): Promise<boolean> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) return false;

  const record = parsePasswordRecord(storedRecord);
  if (!record) return false;

  const actual = await deriveHash(password, record.salt, record.iterations);
  return timingSafeEqual(actual, record.hash);
}
