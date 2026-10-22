import { Hono } from "hono";
import { securityHeaders } from "./middleware/security";
import type { Env } from "./types";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use("/api/*", securityHeaders);

  app.get("/api/health", (context) =>
    context.json({
      status: "ok",
      service: "cloud-genealogy",
    }),
  );

  app.get("/api/me", (context) =>
    context.json(
      {
        code: "authentication_required",
        message: "请先登录。",
      },
      401,
    ),
  );

  app.notFound((context) => context.json({ code: "not_found" }, 404));

  return app;
}
