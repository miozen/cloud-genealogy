import type { MiddlewareHandler } from "hono";

export const securityHeaders: MiddlewareHandler = async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Referrer-Policy", "same-origin");
  context.header("Cache-Control", "no-store");
};
