import { describe, expect, it } from "vitest";
import { createMediaUploadIntent, finalizeMediaUpload, maximumMediaBytes, retireMediaAsset } from "../worker/media/media-asset";

const now = new Date("2026-10-25T00:00:00.000Z");
const input = {
  id: "11111111-1111-4111-8111-111111111111",
  sha256: "a".repeat(64),
  byteSize: 128,
  mimeType: "image/jpeg" as const,
  originalFilename: "先祖照片.jpg",
  visibility: "MEMBER" as const,
  createdByAccountId: "22222222-2222-4222-8222-222222222222",
};

describe("media asset state", () => {
  it("creates an immutable random-key upload intent with a five-minute expiry", () => {
    const intent = createMediaUploadIntent(input, now);
    expect(intent.objectKey).toBe(`media/${input.id}`);
    expect(intent.state).toBe("pending_upload");
    expect(intent.uploadExpiresAt).toBe("2026-10-25T00:05:00.000Z");
  });

  it("rejects unsupported metadata before any R2 operation", () => {
    expect(() => createMediaUploadIntent({ ...input, sha256: "bad" }, now)).toThrow("media_sha256_invalid");
    expect(() => createMediaUploadIntent({ ...input, byteSize: maximumMediaBytes + 1 }, now)).toThrow("media_size_invalid");
    expect(() => createMediaUploadIntent({ ...input, mimeType: "image/svg+xml" as never }, now)).toThrow("media_mime_invalid");
    expect(() => createMediaUploadIntent({ ...input, originalFilename: "bad\u0000name.jpg" }, now)).toThrow("media_filename_invalid");
  });

  it("activates only an unexpired upload whose R2 metadata matches the intent", () => {
    const intent = createMediaUploadIntent(input, now);
    expect(finalizeMediaUpload(intent, { sha256: input.sha256, byteSize: 128, mimeType: "image/jpeg", etag: "etag" }, new Date("2026-10-25T00:04:59.000Z"))).toMatchObject({ state: "active", r2Etag: "etag" });
    expect(finalizeMediaUpload(intent, { sha256: "b".repeat(64), byteSize: 128, mimeType: "image/jpeg", etag: "etag" }, now)).toMatchObject({ state: "failed", r2Etag: null });
    expect(finalizeMediaUpload(intent, null, new Date("2026-10-25T00:05:01.000Z"))).toMatchObject({ state: "failed" });
  });

  it("does not retire an active asset until every active reference is removed", () => {
    expect(() => retireMediaAsset("active", 1, now)).toThrow("media_still_referenced");
    expect(retireMediaAsset("active", 0, now)).toEqual({ state: "retired", retiredAt: "2026-10-25T00:00:00.000Z", cleanupAfter: "2026-11-24T00:00:00.000Z" });
  });
});
