import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashOpaqueToken, matchesOpaqueToken } from "../worker/auth/opaque-token";

describe("opaque session and CSRF tokens", () => {
  it("creates unique tokens and stores only their hash", async () => {
    const token = createOpaqueToken();
    const anotherToken = createOpaqueToken();
    const hash = await hashOpaqueToken(token);

    expect(token).not.toBe(anotherToken);
    expect(hash).not.toContain(token);
    await expect(matchesOpaqueToken(token, hash)).resolves.toBe(true);
    await expect(matchesOpaqueToken(anotherToken, hash)).resolves.toBe(false);
  });
});
