export const mediaMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaMimeType = typeof mediaMimeTypes[number];
export type MediaVisibility = "PUBLIC" | "MEMBER" | "ADMIN";
export type MediaAssetState = "pending_upload" | "active" | "failed" | "retired";

export const maximumMediaBytes = 10 * 1024 * 1024;
export const uploadIntentLifetimeMs = 5 * 60 * 1000;
export const retiredMediaRetentionMs = 30 * 24 * 60 * 60 * 1000;

export type MediaUploadIntent = {
  id: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  mimeType: MediaMimeType;
  originalFilename: string;
  visibility: MediaVisibility;
  state: "pending_upload";
  createdByAccountId: string;
  createdAt: string;
  uploadExpiresAt: string;
};

export type UploadedMediaObject = { sha256: string; byteSize: number; mimeType: string; etag: string | null };
export type FinalizedMediaAsset = Pick<MediaUploadIntent, "id" | "objectKey" | "sha256" | "byteSize" | "mimeType" | "visibility" | "createdByAccountId" | "createdAt"> & {
  state: "active" | "failed";
  finalizedAt: string | null;
  failedAt: string | null;
  cleanupAfter: string | null;
  r2Etag: string | null;
};

function isSha256(value: string) { return /^[0-9a-f]{64}$/.test(value); }
function isMediaMimeType(value: string): value is MediaMimeType { return mediaMimeTypes.includes(value as MediaMimeType); }
function containsControlCharacter(value: string) { return [...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); }

export function createMediaUploadIntent(input: Omit<MediaUploadIntent, "objectKey" | "state" | "createdAt" | "uploadExpiresAt">, now: Date): MediaUploadIntent {
  if (!isSha256(input.sha256)) throw new Error("media_sha256_invalid");
  if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > maximumMediaBytes) throw new Error("media_size_invalid");
  if (!isMediaMimeType(input.mimeType)) throw new Error("media_mime_invalid");
  if (!input.originalFilename.trim() || input.originalFilename.length > 255 || containsControlCharacter(input.originalFilename)) throw new Error("media_filename_invalid");
  return {
    ...input,
    objectKey: `media/${input.id}`,
    state: "pending_upload",
    createdAt: now.toISOString(),
    uploadExpiresAt: new Date(now.getTime() + uploadIntentLifetimeMs).toISOString(),
  };
}

export function finalizeMediaUpload(intent: MediaUploadIntent, uploaded: UploadedMediaObject | null, now: Date): FinalizedMediaAsset {
  const base = { id: intent.id, objectKey: intent.objectKey, sha256: intent.sha256, byteSize: intent.byteSize, mimeType: intent.mimeType, visibility: intent.visibility, createdByAccountId: intent.createdByAccountId, createdAt: intent.createdAt };
  const valid = now.getTime() <= Date.parse(intent.uploadExpiresAt)
    && uploaded !== null
    && uploaded.sha256 === intent.sha256
    && uploaded.byteSize === intent.byteSize
    && uploaded.mimeType === intent.mimeType;
  if (valid) return { ...base, state: "active", finalizedAt: now.toISOString(), failedAt: null, cleanupAfter: null, r2Etag: uploaded.etag };
  return { ...base, state: "failed", finalizedAt: null, failedAt: now.toISOString(), cleanupAfter: new Date(now.getTime() + retiredMediaRetentionMs).toISOString(), r2Etag: null };
}

export function retireMediaAsset(state: MediaAssetState, activeReferenceCount: number, now: Date) {
  if (state !== "active") throw new Error("media_not_active");
  if (!Number.isInteger(activeReferenceCount) || activeReferenceCount !== 0) throw new Error("media_still_referenced");
  return { state: "retired" as const, retiredAt: now.toISOString(), cleanupAfter: new Date(now.getTime() + retiredMediaRetentionMs).toISOString() };
}
