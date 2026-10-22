import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hasPermission } from "./auth/authorization";
import { consumeLoginRateLimit } from "./auth/login-rate-limit-store";
import { createOpaqueToken, hashOpaqueToken } from "./auth/opaque-token";
import { hashPassword, verifyPassword } from "./auth/password";
import { createLoginRateLimitKey } from "./auth/rate-limit";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./auth/session";
import {
  approvalInput,
  loginInput,
  registrationInput,
  rejectionInput,
  resetPasswordInput,
  validationMessage,
} from "./auth/validation";
import { csrfProtection, requireAuthentication, sessionMiddleware } from "./middleware/authentication";
import { securityHeaders } from "./middleware/security";
import type { AppEnv } from "./types";

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  status: "pending" | "active" | "disabled" | "rejected";
}

interface PendingAccountRow {
  id: string;
  username: string;
  display_name: string;
  registration_branch_name: string | null;
  registration_ancestor_name: string | null;
  version: number;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function cookieOptions(context: { env: AppEnv["Bindings"] }) {
  return {
    httpOnly: true,
    secure: context.env.APP_ENV !== "development",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

function clientRateIdentifier(context: { req: { header(name: string): string | undefined } }, username: string): string {
  return `${username}|${context.req.header("cf-connecting-ip") ?? "local"}`;
}

async function writeAudit(
  database: D1Database,
  actorAccountId: string | null,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await database
    .prepare(
      "INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), actorAccountId, action, objectType, objectId, JSON.stringify(metadata), now())
    .run();
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("/api/*", securityHeaders);
  app.use("/api/*", sessionMiddleware);
  app.use("/api/*", csrfProtection);

  app.get("/api/health", (context) =>
    context.json({
      status: "ok",
      service: "cloud-genealogy",
    }),
  );

  app.get("/api/me", requireAuthentication, (context) => {
    const auth = context.get("auth")!;
    return context.json({
      account: {
        id: auth.accountId,
        username: auth.username,
        displayName: auth.displayName,
        roles: auth.roles,
      },
    });
  });

  app.post("/api/auth/register", async (context) => {
    const parsed = registrationInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);

    const input = parsed.data;
    const accountId = crypto.randomUUID();
    const timestamp = now();
    const passwordHash = await hashPassword(input.password);
    try {
      await context.env.DB
        .prepare(
          `INSERT INTO account (
             id, username, display_name, registration_branch_name, registration_ancestor_name,
             password_scheme, password_hash, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          accountId,
          input.username,
          input.genealogyName,
          input.branchName ?? null,
          input.ancestorName ?? null,
          "pbkdf2-sha256",
          passwordHash,
          timestamp,
          timestamp,
        )
        .run();
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        return context.json({ code: "username_unavailable", message: "该用户名不可用。" }, 409);
      }
      throw error;
    }

    await writeAudit(context.env.DB, null, "account.registered", "account", accountId, { username: input.username });
    return context.json({ status: "pending", message: "注册申请已提交，等待管理员审核。" }, 201);
  });

  app.post("/api/auth/login", async (context) => {
    const parsed = loginInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const input = parsed.data;

    const keyHash = await createLoginRateLimitKey(clientRateIdentifier(context, input.username), context.env.AUTH_RATE_LIMIT_SECRET);
    const rateLimit = await consumeLoginRateLimit(context.env.DB, keyHash);
    if (!rateLimit.allowed) {
      return context.json({ code: "login_rate_limited", message: "登录尝试过于频繁，请稍后重试。" }, 429, { "retry-after": String(rateLimit.retryAfterSeconds) });
    }

    const account = await context.env.DB
      .prepare("SELECT id, username, display_name, password_hash, status FROM account WHERE username = ?")
      .bind(input.username)
      .first<AccountRow>();
    if (!account || !(await verifyPassword(input.password, account.password_hash))) {
      return context.json({ code: "login_failed", message: "用户名或密码错误。" }, 401);
    }
    if (account.status !== "active") {
      const message = account.status === "pending" ? "账号正在等待管理员审核。" : "该账号当前不可用。";
      return context.json({ code: "account_unavailable", message }, 403);
    }

    const sessionToken = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1_000).toISOString();
    await context.env.DB
      .prepare(
        "INSERT INTO auth_session (id_hash, account_id, csrf_secret_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(await hashOpaqueToken(sessionToken), account.id, await hashOpaqueToken(csrfToken), expiresAt, now(), now())
      .run();

    setCookie(context, SESSION_COOKIE_NAME, sessionToken, cookieOptions(context));
    setCookie(context, CSRF_COOKIE_NAME, csrfToken, { ...cookieOptions(context), httpOnly: false });
    await writeAudit(context.env.DB, account.id, "account.login", "account", account.id, {});
    return context.json({ csrfToken, account: { id: account.id, username: account.username, displayName: account.display_name } });
  });

  app.post("/api/auth/logout", requireAuthentication, async (context) => {
    const token = getCookie(context, SESSION_COOKIE_NAME);
    if (token) {
      await context.env.DB.prepare("UPDATE auth_session SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL").bind(now(), await hashOpaqueToken(token)).run();
    }
    deleteCookie(context, SESSION_COOKIE_NAME, { path: "/" });
    deleteCookie(context, CSRF_COOKIE_NAME, { path: "/" });
    return context.body(null, 204);
  });

  app.get("/api/admin/accounts/pending", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const rows = await context.env.DB
      .prepare(
        `SELECT id, username, display_name, registration_branch_name, registration_ancestor_name, version, created_at
         FROM account WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`,
      )
      .all<PendingAccountRow>();
    return context.json({ accounts: rows.results });
  });

  app.post("/api/admin/accounts/:accountId/approve", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = approvalInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const input = parsed.data;
    const accountId = context.req.param("accountId");
    const person = await context.env.DB.prepare("SELECT id FROM person WHERE id = ?").bind(input.personId).first<{ id: string }>();
    if (!person) return context.json({ code: "person_not_found", message: "请选择已存在的族谱人物。" }, 404);

    const timestamp = now();
    const approval = await context.env.DB
      .prepare(
        `UPDATE account SET status = 'active', reviewed_at = ?, reviewed_by_account_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND version = ?`,
      )
      .bind(timestamp, auth.accountId, timestamp, accountId, input.version)
      .run();
    if (approval.meta.changes !== 1) return context.json({ code: "review_conflict", message: "账号状态已变化，请刷新后重试。" }, 409);

    const roleIds = ["role-member", ...(input.role === "member" ? [] : [`role-${input.role}`])];
    await context.env.DB.batch([
      ...roleIds.map((roleId) =>
        context.env.DB.prepare(
          "INSERT INTO account_role (account_id, role_id, granted_at, granted_by_account_id) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, role_id) DO NOTHING",
        ).bind(accountId, roleId, timestamp, auth.accountId),
      ),
      context.env.DB
        .prepare("INSERT INTO account_person_link (account_id, person_id, linked_at, linked_by_account_id) VALUES (?, ?, ?, ?)")
        .bind(accountId, input.personId, timestamp, auth.accountId),
      context.env.DB
        .prepare(
          "INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), auth.accountId, "account.approved", "account", accountId, JSON.stringify({ personId: input.personId, role: input.role }), timestamp),
    ]);
    return context.json({ status: "active" });
  });

  app.post("/api/admin/accounts/:accountId/reject", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = rejectionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const accountId = context.req.param("accountId");
    const timestamp = now();
    const rejection = await context.env.DB
      .prepare("UPDATE account SET status = 'rejected', reviewed_at = ?, reviewed_by_account_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ?")
      .bind(timestamp, auth.accountId, timestamp, accountId, parsed.data.version)
      .run();
    if (rejection.meta.changes !== 1) return context.json({ code: "review_conflict", message: "账号状态已变化，请刷新后重试。" }, 409);
    await writeAudit(context.env.DB, auth.accountId, "account.rejected", "account", accountId, {});
    return context.json({ status: "rejected" });
  });

  app.post("/api/admin/accounts/:accountId/reset-password", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = resetPasswordInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const accountId = context.req.param("accountId");
    const passwordHash = await hashPassword(parsed.data.password);
    const timestamp = now();
    const result = await context.env.DB
      .prepare("UPDATE account SET password_scheme = ?, password_hash = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .bind("pbkdf2-sha256", passwordHash, timestamp, accountId)
      .run();
    if (result.meta.changes !== 1) return context.json({ code: "account_not_found" }, 404);
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE auth_session SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(timestamp, accountId),
      context.env.DB
        .prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), auth.accountId, "account.password_reset", "account", accountId, "{}", timestamp),
    ]);
    return context.body(null, 204);
  });

  app.notFound((context) => context.json({ code: "not_found" }, 404));

  return app;
}
