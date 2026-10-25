export type MediaUploadVisibility = "PUBLIC" | "MEMBER" | "ADMIN";

type UploadInstruction = {
  url: string;
  requiredHeaders: { "content-type": string; "x-amz-checksum-sha256": string };
};

type UploadIntentResponse = { mediaAsset: { id: string }; upload: UploadInstruction };

export class MediaUploadError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export async function uploadMediaFile(
  file: File,
  visibility: MediaUploadVisibility,
  apiRequest: (path: string, options?: RequestInit) => Promise<Response>,
  directFetch: typeof fetch = fetch,
) {
  const sha256 = await sha256Hex(await file.arrayBuffer());
  const intentResponse = await apiRequest("/api/admin/media-assets/upload-intents", {
    method: "POST",
    body: JSON.stringify({ sha256, byteSize: file.size, mimeType: file.type, originalFilename: file.name, visibility }),
  });
  if (!intentResponse.ok) throw new MediaUploadError(await responseCode(intentResponse));
  const intent = await intentResponse.json() as UploadIntentResponse;
  const putResponse = await directFetch(intent.upload.url, {
    method: "PUT",
    headers: intent.upload.requiredHeaders,
    body: file,
  });
  if (!putResponse.ok) throw new MediaUploadError("media_direct_upload_failed");
  const completionResponse = await apiRequest(`/api/admin/media-assets/${encodeURIComponent(intent.mediaAsset.id)}/complete`, { method: "POST" });
  if (!completionResponse.ok) throw new MediaUploadError(await responseCode(completionResponse));
  return completionResponse.json() as Promise<{ mediaAsset: { id: string; state: "active" } }>;
}

async function sha256Hex(value: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseCode(response: Response) {
  const body = await response.json().catch(() => ({})) as { code?: string };
  return body.code ?? "media_upload_request_failed";
}
