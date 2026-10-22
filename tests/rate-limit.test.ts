import { describe, expect, it } from "vitest";
import {
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  createLoginRateLimitKey,
  evaluateLoginRateLimit,
} from "../worker/auth/rate-limit";

describe("login rate limiting", () => {
  it("blocks the attempt after the configured threshold until the window expires", () => {
    const now = 1_000_000;
    let state = null;

    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const decision = evaluateLoginRateLimit(state, now);
      expect(decision.allowed).toBe(true);
      state = decision.nextState;
    }

    const blocked = evaluateLoginRateLimit(state, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    const reset = evaluateLoginRateLimit(blocked.nextState, now + LOGIN_RATE_LIMIT_WINDOW_MS);
    expect(reset.allowed).toBe(true);
    expect(reset.nextState.attempts).toBe(1);
  });

  it("creates a stable secret-derived key without exposing the identifier", async () => {
    const first = await createLoginRateLimitKey("person@example.test", "test-secret");
    const second = await createLoginRateLimitKey(" PERSON@example.test ", "test-secret");

    expect(first).toBe(second);
    expect(first).not.toContain("person@example.test");
  });
});
