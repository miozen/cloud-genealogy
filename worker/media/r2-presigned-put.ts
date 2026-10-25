import { mediaMimeTypes, type MediaMimeType } from "./media-asset";

export const mediaUploadUrlLifetimeSeconds = 5 * 60;
const algorithm = "AWS4-HMAC-SHA256";
const region = "auto";
const service = "s3";
const unsignedPayload = "UNSIGNED-PAYLOAD";

export type R2PresignedPutInput = {
  accountId: string;
  bucket: string;
  objectKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  mimeType: MediaMimeType;
  sha256: string;
  issuedAt: Date;
  expiresInSeconds?: number;
};

export type R2PresignedPut = {
  url: string;
  expiresAt: string;
  requiredHeaders: { "content-type": MediaMimeType; "x-amz-checksum-sha256": string };
};

/**
 * Creates a single-object R2 S3-compatible presigned PUT URL without making a
 * network request. The caller must keep the S3 secret in a Worker Secret.
 */
export async function createR2PresignedPut(input: R2PresignedPutInput): Promise<R2PresignedPut> {
  validate(input);
  const expiresInSeconds = input.expiresInSeconds ?? mediaUploadUrlLifetimeSeconds;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 7 * 24 * 60 * 60) throw new Error("r2_presign_expiry_invalid");

  const host = `${input.bucket}.${input.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${input.objectKey.split("/").map(awsEncode).join("/")}`;
  const date = amzDate(input.issuedAt);
  const shortDate = date.slice(0, 8);
  const credentialScope = `${shortDate}/${region}/${service}/aws4_request`;
  const checksum = hexToBase64(input.sha256);
  const signedHeaders = "content-type;host;x-amz-checksum-sha256";
  const query = new Map<string, string>([
    ["X-Amz-Algorithm", algorithm],
    ["X-Amz-Content-Sha256", unsignedPayload],
    ["X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", date],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]);
  const canonicalQuery = canonicalQueryString(query);
  const canonicalHeaders = `content-type:${input.mimeType}\nhost:${host}\nx-amz-checksum-sha256:${checksum}\n`;
  const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${unsignedPayload}`;
  const stringToSign = `${algorithm}\n${date}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
  const signingKey = await deriveSigningKey(input.secretAccessKey, shortDate);
  const signature = await hmacHex(signingKey, stringToSign);
  query.set("X-Amz-Signature", signature);

  return {
    url: `https://${host}${canonicalUri}?${canonicalQueryString(query)}`,
    expiresAt: new Date(input.issuedAt.getTime() + expiresInSeconds * 1000).toISOString(),
    requiredHeaders: { "content-type": input.mimeType, "x-amz-checksum-sha256": checksum },
  };
}

function validate(input: R2PresignedPutInput) {
  if (!/^[a-f0-9]{32}$/.test(input.accountId)) throw new Error("r2_presign_account_invalid");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("r2_presign_bucket_invalid");
  if (!input.objectKey.startsWith("media/") || input.objectKey.split("/").some((part) => !part || part === "." || part === ".." || hasControlCharacter(part))) throw new Error("r2_presign_key_invalid");
  if (!input.accessKeyId || hasControlCharacter(input.accessKeyId)) throw new Error("r2_presign_access_key_invalid");
  if (!input.secretAccessKey || hasControlCharacter(input.secretAccessKey)) throw new Error("r2_presign_secret_key_invalid");
  if (!mediaMimeTypes.includes(input.mimeType)) throw new Error("r2_presign_mime_invalid");
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("r2_presign_checksum_invalid");
  if (Number.isNaN(input.issuedAt.getTime())) throw new Error("r2_presign_date_invalid");
}

function hasControlCharacter(value: string) { return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127); }
function awsEncode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function canonicalQueryString(values: ReadonlyMap<string, string>) { return [...values.entries()].map(([key, value]) => [awsEncode(key), awsEncode(value)] as const).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}=${value}`).join("&"); }
function amzDate(value: Date) { return value.toISOString().replace(/[:-]|\.\d{3}/g, ""); }
function hexToBase64(value: string) { return btoa(value.match(/.{2}/g)!.map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join("")); }
function text(value: string) { return new TextEncoder().encode(value); }
function textBuffer(value: string): ArrayBuffer { return text(value).buffer as ArrayBuffer; }
async function sha256Hex(value: string) { return toHex(await crypto.subtle.digest("SHA-256", text(value))); }
async function hmac(key: ArrayBuffer, value: string) { return crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), text(value)); }
async function hmacHex(key: ArrayBuffer, value: string) { return toHex(await hmac(key, value)); }
async function deriveSigningKey(secretAccessKey: string, shortDate: string) {
  const dateKey = await hmac(textBuffer(`AWS4${secretAccessKey}`), shortDate);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}
function toHex(value: ArrayBuffer) { return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
