const encoder = new TextEncoder();

export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;

export interface LoginRateLimitState {
  attempts: number;
  windowStartedAt: number;
}

export interface LoginRateLimitDecision {
  allowed: boolean;
  nextState: LoginRateLimitState;
  retryAfterSeconds: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function evaluateLoginRateLimit(
  previous: LoginRateLimitState | null,
  now: number,
  maxAttempts = LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  windowMs = LOGIN_RATE_LIMIT_WINDOW_MS,
): LoginRateLimitDecision {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAttempts) || !Number.isSafeInteger(windowMs)) {
    throw new Error("Rate limit inputs are invalid.");
  }

  const expired = previous === null || now - previous.windowStartedAt >= windowMs;
  const current = expired ? { attempts: 0, windowStartedAt: now } : previous;
  const nextState = { ...current, attempts: current.attempts + 1 };
  const allowed = nextState.attempts <= maxAttempts;

  return {
    allowed,
    nextState,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((current.windowStartedAt + windowMs - now) / 1_000)),
  };
}

export async function createLoginRateLimitKey(identifier: string, secret: string): Promise<string> {
  if (!identifier || !secret) throw new Error("Rate limit identifier and secret are required.");

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(identifier.trim().toLowerCase()));
  return toBase64Url(new Uint8Array(signature));
}
