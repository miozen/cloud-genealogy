import { LOGIN_RATE_LIMIT_MAX_ATTEMPTS, LOGIN_RATE_LIMIT_WINDOW_MS } from "./rate-limit";

interface RateLimitRow {
  attempt_count: number;
  window_started_at: string;
}

export interface PersistedRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Count each login attempt before account lookup. The upsert is a single D1
 * write, so parallel requests cannot bypass the counter with a read/write race.
 */
export async function consumeLoginRateLimit(
  database: D1Database,
  keyHash: string,
  now = new Date(),
): Promise<PersistedRateLimitDecision> {
  const nowIso = now.toISOString();
  const expiryIso = new Date(now.getTime() - LOGIN_RATE_LIMIT_WINDOW_MS).toISOString();

  await database
    .prepare(
      `INSERT INTO auth_login_rate_limit (key_hash, window_started_at, attempt_count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         window_started_at = CASE WHEN auth_login_rate_limit.window_started_at <= ? THEN excluded.window_started_at ELSE auth_login_rate_limit.window_started_at END,
         attempt_count = CASE WHEN auth_login_rate_limit.window_started_at <= ? THEN 1 ELSE auth_login_rate_limit.attempt_count + 1 END,
         updated_at = excluded.updated_at`,
    )
    .bind(keyHash, nowIso, nowIso, expiryIso, expiryIso)
    .run();

  const state = await database
    .prepare("SELECT attempt_count, window_started_at FROM auth_login_rate_limit WHERE key_hash = ?")
    .bind(keyHash)
    .first<RateLimitRow>();

  if (!state) throw new Error("Login rate limit state was not persisted.");
  if (state.attempt_count <= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) return { allowed: true, retryAfterSeconds: 0 };

  const windowEndsAt = new Date(state.window_started_at).getTime() + LOGIN_RATE_LIMIT_WINDOW_MS;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAt - now.getTime()) / 1_000)),
  };
}
