import { describe, expect, it, vi } from "vitest";
import { MediaUploadError, uploadMediaFile } from "../src/media-upload";

describe("browser media upload", () => {
  it("uses the authenticated API only for intent and completion, and sends only signed headers to R2", async () => {
    const file = new File(["local image"], "ancestor.jpg", { type: "image/jpeg" });
    const apiRequest = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ mediaAsset: { id: "asset-1" }, upload: { url: "https://bucket.example/media/asset-1", requiredHeaders: { "content-type": "image/jpeg", "x-amz-checksum-sha256": "checksum" } } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ mediaAsset: { id: "asset-1", state: "active" } }), { status: 200 }));
    const directFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(uploadMediaFile(file, "MEMBER", apiRequest, directFetch)).resolves.toEqual({ mediaAsset: { id: "asset-1", state: "active" } });
    expect(apiRequest).toHaveBeenNthCalledWith(1, "/api/admin/media-assets/upload-intents", expect.objectContaining({ method: "POST" }));
    expect(apiRequest).toHaveBeenNthCalledWith(2, "/api/admin/media-assets/asset-1/complete", { method: "POST" });
    expect(directFetch).toHaveBeenCalledWith("https://bucket.example/media/asset-1", { method: "PUT", headers: { "content-type": "image/jpeg", "x-amz-checksum-sha256": "checksum" }, body: file });
  });

  it("does not attempt a direct PUT when the server has not configured signing", async () => {
    const file = new File(["local image"], "ancestor.jpg", { type: "image/jpeg" });
    const apiRequest = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "media_direct_upload_unavailable" }), { status: 503 }));
    const directFetch = vi.fn();
    await expect(uploadMediaFile(file, "MEMBER", apiRequest, directFetch)).rejects.toEqual(new MediaUploadError("media_direct_upload_unavailable"));
    expect(directFetch).not.toHaveBeenCalled();
  });
});
