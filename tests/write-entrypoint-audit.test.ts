import source from "../worker/app.ts?raw";
import revisionSource from "../worker/lineage/revision-publish.ts?raw";
import rateLimitSource from "../worker/auth/login-rate-limit-store.ts?raw";
import inventorySource from "./fixtures/write-entrypoint-inventory.json?raw";
import { describe, expect, it } from "vitest";
import { auditEntryPoints, type InventoryEntry } from "./fixtures/write-entrypoint-audit";

const inventory = JSON.parse(inventorySource) as InventoryEntry[];

describe("write route inventory", () => {
  it("classifies every registered route and checks its reviewed guard marker", () => {
    expect(auditEntryPoints(source, inventory)).toEqual([]);
    expect(inventory.filter((entry) => entry.kind === "guarded")).toHaveLength(44);
  });
  it("rejects an unreviewed write route or dynamic registration", () => {
    expect(auditEntryPoints(`${source}\napp.post('/api/new', () => {});`, inventory)).toContain("unregistered route: POST /api/new");
    expect(auditEntryPoints(`${source}\napp.on('POST', '/api/new', handler);`, inventory)).toContain("unsupported route registration: on");
    expect(auditEntryPoints(`${source}\napp.post(dynamicPath, handler);`, inventory)).toContain("dynamic post path requires review");
    expect(auditEntryPoints(`${source}\napp.route('/api/new', router);`, inventory)).toContain("unsupported route registration: route");
    expect(auditEntryPoints(`${source}\napp[method]('/api/new', handler);`, inventory)).toContain("dynamic app access requires review");
    expect(auditEntryPoints(`${source}\napp.use('/api/*', newMiddleware);`, inventory)).toContain("unreviewed middleware registration");
    expect(auditEntryPoints(`${source}\napp.options('/api/new', handler);`, inventory)).toContain("unsupported route registration: options");
    expect(auditEntryPoints(`${source}\nconst api = app;`, inventory)).toContain("app alias requires review");
  });
  it("rejects removal of a reviewed guard marker", () => {
    const changed = source.replace('await fencedBatch(context.env.DB, context.get("backupAdmissionId"), [', 'await unguardedBatch(context.env.DB, context.get("backupAdmissionId"), [');
    expect(auditEntryPoints(changed, inventory)).toContain("guard marker missing: POST /api/setup/bootstrap");
  });
  it("checks the delegated publication, claim and rate-limit helpers", () => {
    expect(revisionSource).toContain("await fencedBatch(database, input.admissionId, statements)");
    expect(revisionSource).not.toMatch(/database\s*\.\s*batch\s*\(/u);
    const claimHelper = source.slice(source.indexOf("const retractSourceClaim ="), source.indexOf('app.post("/api/admin/source-fact-claims/:claimId/retract"'));
    expect(claimHelper).toContain("fencedLifecycleUpdate");
    expect(claimHelper).toContain("activeWriteAdmissionGuard");
    expect(rateLimitSource).toContain("fencedBatch(database, admissionId");
  });
  it("rejects an obvious write added to an inventoried GET route", () => {
    const changed = source.replace('app.get("/api/health", async (context) => {', 'app.get("/api/health", async (context) => { await context.env.DB.prepare("DELETE FROM account").run();');
    expect(auditEntryPoints(changed, inventory)).toContain("read route contains a direct write: GET /api/health");
    const changedFallback = source.replace("app.onError((error, context) => {", "app.onError((error, context) => { context.env.DB.prepare('DELETE FROM account').run();");
    expect(auditEntryPoints(changedFallback, inventory)).toContain("fallback handler contains a direct write: onError");
  });
});
