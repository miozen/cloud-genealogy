import { describe, expect, it } from "vitest";
import { createApp } from "../worker/app";

describe("worker app", () => {
  it("serves a health response", async () => {
    const response = await createApp().request("https://example.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects an unauthenticated identity request", async () => {
    const response = await createApp().request("https://example.test/api/me");

    expect(response.status).toBe(401);
  });
});
