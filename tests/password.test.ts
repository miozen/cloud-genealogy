import { describe, expect, it } from "vitest";
import { PBKDF2_ITERATIONS, hashPassword, verifyPassword } from "../worker/auth/password";

describe("password records", () => {
  it("round-trips a password without exposing its plaintext", async () => {
    const record = await hashPassword("correct horse battery staple", 1_000);

    expect(record).toMatch(/^pbkdf2-sha256\$1000\$/u);
    expect(record).not.toContain("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", record)).resolves.toBe(true);
    await expect(verifyPassword("incorrect password", record)).resolves.toBe(false);
  });

  it("rejects malformed records and invalid passwords", async () => {
    await expect(verifyPassword("password", "not-a-password-record")).resolves.toBe(false);
    await expect(verifyPassword("", "not-a-password-record")).resolves.toBe(false);
  });

  it("measures the approved Workers-compatible PBKDF2 work factor locally", async () => {
    const startedAt = performance.now();
    const record = await hashPassword("benchmark-only-password");
    const elapsedMs = performance.now() - startedAt;

    expect(record).toMatch(new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$`, "u"));
    console.info(`PBKDF2 ${PBKDF2_ITERATIONS} iterations completed locally in ${elapsedMs.toFixed(1)} ms.`);
  });
});
