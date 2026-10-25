import { describe, expect, it } from "vitest";
import { createR2PresignedPut, mediaUploadUrlLifetimeSeconds } from "../worker/media/r2-presigned-put";

const input = {
  accountId: "0123456789abcdef0123456789abcdef",
  bucket: "cloud-genealogy-preview",
  objectKey: "media/11111111-1111-4111-8111-111111111111",
  accessKeyId: "example-access-key",
  secretAccessKey: "example-secret-key",
  mimeType: "image/webp" as const,
  sha256: "a".repeat(64),
  issuedAt: new Date("2026-10-25T12:34:56.000Z"),
};

describe("R2 presigned PUT", () => {
  it("deterministically scopes a five-minute PUT to one R2 object and required headers", async () => {
    const first = await createR2PresignedPut(input);
    const second = await createR2PresignedPut(input);
    expect(first).toEqual(second);
    const url = new URL(first.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://cloud-genealogy-preview.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/media/11111111-1111-4111-8111-111111111111");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("example-access-key/20261025/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(mediaUploadUrlLifetimeSeconds));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;x-amz-checksum-sha256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(first.expiresAt).toBe("2026-10-25T12:39:56.000Z");
    expect(first.requiredHeaders).toEqual({ "content-type": "image/webp", "x-amz-checksum-sha256": "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=" });
  });

  it("rejects unsafe scope and invalid signing inputs before producing a bearer URL", async () => {
    await expect(createR2PresignedPut({ ...input, objectKey: "media/../other" })).rejects.toThrow("r2_presign_key_invalid");
    await expect(createR2PresignedPut({ ...input, sha256: "not-a-checksum" })).rejects.toThrow("r2_presign_checksum_invalid");
    await expect(createR2PresignedPut({ ...input, expiresInSeconds: 0 })).rejects.toThrow("r2_presign_expiry_invalid");
  });
});
