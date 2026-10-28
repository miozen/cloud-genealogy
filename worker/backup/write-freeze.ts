import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

export interface ActiveBackupWriteFreeze {
  id: string;
  reason: string;
  createdByAccountId: string;
  createdAt: string;
}

export function isBackupProtectedWrite(method: string, path: string): boolean {
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method)) return false;
  if (!path.startsWith("/api/")) return false;
  if (path === "/api/admin/backup-write-freeze" || path === "/api/admin/backup-write-freeze/release") return false;
  // This endpoint calculates an in-memory preview and never writes D1 or R2.
  if (/^\/api\/admin\/lineages\/[^/]+\/revisions\/preview$/u.test(path)) return false;
  return true;
}

export async function activeBackupWriteFreeze(database: D1Database): Promise<ActiveBackupWriteFreeze | null> {
  return database.prepare(
    "SELECT id, reason, created_by_account_id AS createdByAccountId, created_at AS createdAt FROM backup_write_freeze WHERE released_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1",
  ).first<ActiveBackupWriteFreeze>();
}

/** Atomically admits each API write only while no freeze exists. */
export const backupWriteFreezeProtection: MiddlewareHandler<AppEnv> = createMiddleware(async (context, next) => {
  if (!isBackupProtectedWrite(context.req.method, context.req.path)) {
    await next();
    return;
  }
  const admissionId = crypto.randomUUID();
  const result = await context.env.DB.prepare(
    "INSERT INTO backup_write_admission (id, admitted_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM backup_write_freeze WHERE released_at IS NULL)",
  ).bind(admissionId, new Date().toISOString()).run();
  if (result.meta.changes !== 1) {
    const freeze = await activeBackupWriteFreeze(context.env.DB);
    return context.json({
      code: "backup_write_freeze_active",
      message: "备份写冻结进行中，暂不接受业务变更。",
      freeze: freeze ? { id: freeze.id, createdAt: freeze.createdAt } : null,
    }, 423);
  }
  try {
    await next();
  } finally {
    await context.env.DB.prepare("UPDATE backup_write_admission SET completed_at = ? WHERE id = ? AND completed_at IS NULL").bind(new Date().toISOString(), admissionId).run();
  }
});
