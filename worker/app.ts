import { Hono } from "hono";
import { csrfProtection, requireAuthentication, sessionMiddleware } from "./middleware/authentication";
import { securityHeaders } from "./middleware/security";
import type { AppEnv } from "./types";

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
        displayName: auth.displayName,
        roles: auth.roles,
      },
    });
  });

  app.notFound((context) => context.json({ code: "not_found" }, 404));

  return app;
}
