const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function createOpaqueToken(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16) throw new Error("Token byte length is invalid.");
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function hashOpaqueToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export async function matchesOpaqueToken(token: string, expectedHash: string): Promise<boolean> {
  const actualHash = await hashOpaqueToken(token);
  if (actualHash.length !== expectedHash.length) return false;

  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) {
    difference |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}
