import type { AuthContext, RoleName } from "../types";
import { hashOpaqueToken, matchesOpaqueToken } from "./opaque-token";

export const SESSION_COOKIE_NAME = "cg_session";
export const CSRF_COOKIE_NAME = "cg_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

interface SessionRow {
  account_id: string;
  csrf_secret_hash: string;
  username: string;
  display_name: string;
}

interface RoleRow {
  name: RoleName;
}

export async function loadActiveSession(database: D1Database, token: string, now = new Date().toISOString()): Promise<AuthContext | null> {
  if (!token) return null;

  const tokenHash = await hashOpaqueToken(token);
  const session = await database
    .prepare(
      `SELECT session.account_id, session.csrf_secret_hash, account.username, account.display_name
       FROM auth_session AS session
       INNER JOIN account ON account.id = session.account_id
       WHERE session.id_hash = ?
         AND session.revoked_at IS NULL
         AND session.expires_at > ?
         AND account.status = 'active'`,
    )
    .bind(tokenHash, now)
    .first<SessionRow>();

  if (!session) return null;

  const roleResult = await database
    .prepare(
      `SELECT role.name
       FROM account_role
       INNER JOIN role ON role.id = account_role.role_id
       WHERE account_role.account_id = ?
       ORDER BY role.name`,
    )
    .bind(session.account_id)
    .all<RoleRow>();

  return {
    accountId: session.account_id,
    username: session.username,
    displayName: session.display_name,
    csrfSecretHash: session.csrf_secret_hash,
    roles: roleResult.results.map((role) => role.name),
  };
}

export function requiresCsrfProtection(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export async function hasValidCsrfToken(
  method: string,
  presentedToken: string | undefined,
  csrfSecretHash: string,
): Promise<boolean> {
  if (!requiresCsrfProtection(method)) return true;
  if (!presentedToken) return false;
  return matchesOpaqueToken(presentedToken, csrfSecretHash);
}
