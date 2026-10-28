import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { backupWriteFreezeProtection, isBackupProtectedWrite } from "../worker/backup/write-freeze";
import type { AppEnv } from "../worker/types";

describe("backup write freeze route policy", () => {
  it("blocks administrative business writes while preserving reads and in-memory previews", () => {
    expect(isBackupProtectedWrite("POST", "/api/admin/persons")).toBe(true);
    expect(isBackupProtectedWrite("PUT", "/api/admin/accounts/id/scopes")).toBe(true);
    expect(isBackupProtectedWrite("GET", "/api/admin/persons")).toBe(false);
    expect(isBackupProtectedWrite("POST", "/api/admin/lineages/id/revisions/preview")).toBe(false);
  });

  it("allows freeze administration while blocking authentication writes", () => {
    expect(isBackupProtectedWrite("POST", "/api/admin/backup-write-freeze")).toBe(false);
    expect(isBackupProtectedWrite("POST", "/api/admin/backup-write-freeze/release")).toBe(false);
    expect(isBackupProtectedWrite("POST", "/api/auth/login")).toBe(true);
    expect(isBackupProtectedWrite("POST", "/api/auth/register")).toBe(true);
    expect(isBackupProtectedWrite("POST", "/api/auth/logout")).toBe(true);
    expect(isBackupProtectedWrite("POST", "/api/setup/bootstrap")).toBe(true);
  });
});

describe("backup admission fault handling", () => {
  function fixture() {
    const state = { frozen: false, failCompletion: false, admissions: new Map<string, boolean>() };
    const database = {
      prepare(sql: string) {
        return {
          bind(id: string) {
            return {
              async run() {
                if (sql.startsWith("INSERT")) {
                  if (state.frozen) return { meta: { changes: 0 } };
                  state.admissions.set(id, false);
                  return { meta: { changes: 1 } };
                }
                if (state.failCompletion) throw new Error("simulated D1 completion failure");
                // UPDATE binds timestamp first and the admission ID second.
                return { meta: { changes: 1 } };
              },
            };
          },
          async first() { return state.frozen ? { id: "freeze-1", createdAt: "2026-10-28T00:00:00Z" } : null; },
        };
      },
    };
    // Keep the simulated D1 binding explicit: the middleware binds timestamp
    // and admission ID on completion, and only that exact row is completed.
    const originalPrepare = database.prepare;
    database.prepare = (sql: string) => {
      if (!sql.startsWith("UPDATE")) return originalPrepare(sql);
      return { bind: (_timestamp: string, id?: string) => ({ run: async () => {
        if (state.failCompletion) throw new Error("simulated D1 completion failure");
        if (id) state.admissions.set(id, true);
        return { meta: { changes: 1 } };
      } }), first: async () => null } as ReturnType<typeof originalPrepare>;
    };
    const app = new Hono<AppEnv>();
    app.use("/api/*", backupWriteFreezeProtection);
    return { app, state, env: { DB: database } as unknown as AppEnv["Bindings"] };
  }

  it("retains the admission when completing the record fails", async () => {
    const { app, state, env } = fixture();
    app.post("/api/test", (context) => { state.failCompletion = true; return context.text("done"); });
    const response = await app.request("https://example.test/api/test", { method: "POST" }, env);
    expect(response.status).toBe(500);
    expect([...state.admissions.values()]).toEqual([false]);
  });

  it("records completion even when the handler throws", async () => {
    const { app, state, env } = fixture();
    app.post("/api/test", () => { throw new Error("simulated handler failure"); });
    const response = await app.request("https://example.test/api/test", { method: "POST" }, env);
    expect(response.status).toBe(500);
    expect([...state.admissions.values()]).toEqual([true]);
  });
});
