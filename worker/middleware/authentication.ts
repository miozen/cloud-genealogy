import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  hasValidCsrfToken,
  loadActiveSession,
  requiresCsrfProtection,
} from "../auth/session";
import type { AppEnv } from "../types";

export const sessionMiddleware = createMiddleware<AppEnv>(async (context, next) => {
  const sessionToken = getCookie(context, SESSION_COOKIE_NAME);
  context.set("auth", sessionToken ? await loadActiveSession(context.env.DB, sessionToken) : null);
  await next();
});

export const requireAuthentication = createMiddleware<AppEnv>(async (context, next) => {
  if (!context.get("auth")) {
    return context.json(
      {
        code: "authentication_required",
        message: "请先登录。",
      },
      401,
    );
  }

  await next();
});

export const csrfProtection = createMiddleware<AppEnv>(async (context, next) => {
  if (!requiresCsrfProtection(context.req.method)) {
    await next();
    return;
  }

  // These endpoints establish authentication and therefore cannot yet carry
  // an authenticated CSRF secret. They perform their own strict validation
  // and never act as an already signed-in account.
  if (
    context.req.path === "/api/auth/register" ||
    context.req.path === "/api/auth/login" ||
    context.req.path === "/api/setup/bootstrap"
  ) {
    await next();
    return;
  }

  const auth = context.get("auth");
  if (!auth) {
    return context.json(
      {
        code: "authentication_required",
        message: "请先登录。",
      },
      401,
    );
  }

  const valid = await hasValidCsrfToken(context.req.method, context.req.header(CSRF_HEADER_NAME), auth.csrfSecretHash);
  if (!valid) {
    return context.json(
      {
        code: "csrf_token_invalid",
        message: "请求缺少有效的 CSRF token。",
      },
      403,
    );
  }

  await next();
});
