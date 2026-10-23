import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hasPermission } from "./auth/authorization";
import { consumeLoginRateLimit } from "./auth/login-rate-limit-store";
import { createOpaqueToken, hashOpaqueToken } from "./auth/opaque-token";
import { hashPassword, verifyPassword } from "./auth/password";
import { createLoginRateLimitKey } from "./auth/rate-limit";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./auth/session";
import {
  approvalInput,
  bootstrapInput,
  loginInput,
  genealogyEditionInput,
  genealogyInput,
  personAnchorInput,
  personFactInput,
  personNameInput,
  registrationInput,
  rejectionInput,
  resetPasswordInput,
  sourcePersonLinkInput,
  sourcePersonRecordInput,
  sourceFactClaimInput,
  sourceRelationClaimInput,
  successionEdgesInput,
  publishRevisionInput,
  rollbackRevisionInput,
  validationMessage,
} from "./auth/validation";
import { previewSuccessionRevision } from "./lineage/revision-preview";
import { publishSuccessionRevision, rollbackSuccessionRevision } from "./lineage/revision-publish";
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

interface PersonAnchorRow {
  id: string;
  display_name: string;
  visibility: "PUBLIC" | "MEMBER" | "ADMIN";
}
interface SuccessionRow { parent_person_id: string; child_person_id: string; }
interface PublishedPointerRow { revision_id: string; version: number; }

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

function secretsMatch(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
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

  app.get("/api/health", async (context) => {
    try {
      await context.env.DB.prepare("SELECT 1").first();
      return context.json({ status: "ok", service: "cloud-genealogy" });
    } catch {
      return context.json({ status: "unavailable", service: "cloud-genealogy" }, 503);
    }
  });

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

  app.post("/api/setup/bootstrap", async (context) => {
    if (!secretsMatch(context.req.header("x-bootstrap-secret"), context.env.BOOTSTRAP_SECRET)) {
      return context.json({ code: "not_found" }, 404);
    }
    const parsed = bootstrapInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);

    const existingAdmin = await context.env.DB
      .prepare(
        `SELECT 1 FROM account
         INNER JOIN account_role ON account_role.account_id = account.id
         INNER JOIN role ON role.id = account_role.role_id
         WHERE account.status = 'active' AND role.name = 'admin' LIMIT 1`,
      )
      .first();
    if (existingAdmin) return context.json({ code: "bootstrap_unavailable" }, 409);

    const input = parsed.data;
    const accountId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const timestamp = now();
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch (error) {
      return context.json({
        code: "password_hash_failed",
        ...(context.env.APP_ENV === "development" && error instanceof Error ? { message: error.message } : {}),
      }, 500);
    }
    try {
      await context.env.DB.batch([
        context.env.DB
          .prepare(
            `INSERT INTO account (id, username, display_name, password_scheme, password_hash, status, reviewed_at, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, 1, ?, ?)`,
          )
          .bind(accountId, input.username, input.genealogyName, "pbkdf2-sha256", passwordHash, timestamp, timestamp, timestamp),
        context.env.DB
          .prepare("INSERT INTO person (id, display_name, visibility, created_at, updated_at) VALUES (?, ?, 'MEMBER', ?, ?)")
          .bind(personId, input.genealogyName, timestamp, timestamp),
      ]);
      await context.env.DB.batch([
        context.env.DB
          .prepare("INSERT INTO account_role (account_id, role_id, granted_at, granted_by_account_id) VALUES (?, 'role-member', ?, ?)")
          .bind(accountId, timestamp, accountId),
        context.env.DB
          .prepare("INSERT INTO account_role (account_id, role_id, granted_at, granted_by_account_id) VALUES (?, 'role-admin', ?, ?)")
          .bind(accountId, timestamp, accountId),
        context.env.DB
          .prepare("INSERT INTO account_person_link (account_id, person_id, linked_at, linked_by_account_id) VALUES (?, ?, ?, ?)")
          .bind(accountId, personId, timestamp, accountId),
        context.env.DB
          .prepare(
            "INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(crypto.randomUUID(), accountId, "system.bootstrap_admin", "account", accountId, JSON.stringify({ personId }), timestamp),
      ]);
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        return context.json({ code: "username_unavailable", message: "该用户名不可用。" }, 409);
      }
      throw error;
    }
    return context.json({ status: "bootstrapped" }, 201);
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

  app.post("/api/admin/lineages/:lineageId/revisions/preview", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = successionEdgesInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId");
    const pointer = await context.env.DB.prepare(
      "SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?",
    ).bind(lineageId).first<PublishedPointerRow>();
    const base = pointer
      ? await context.env.DB.prepare(
        "SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key",
      ).bind(pointer.revision_id).all<SuccessionRow>()
      : { results: [] as SuccessionRow[] };
    return context.json({
      pointer: { revisionId: pointer?.revision_id ?? null, version: pointer?.version ?? 0 },
      preview: previewSuccessionRevision({ baseEdges: base.results.map((row) => ({ parentPersonId: row.parent_person_id, childPersonId: row.child_person_id })), proposedEdges: parsed.data.edges }),
    });
  });

  app.get("/api/admin/lineages/:lineageId/projection", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const lineageId = context.req.param("lineageId");
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(lineageId).first<PublishedPointerRow>();
    if (!pointer) return context.json({ code: "published_revision_not_found" }, 404);
    const edges = await context.env.DB.prepare(
      "SELECT parent_person_id, child_person_id, order_key FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key, id",
    ).bind(pointer.revision_id).all();
    return context.json({ view: "canonical", lineageId, revisionId: pointer.revision_id, pointerVersion: pointer.version, edges: edges.results });
  });

  app.get("/api/admin/genealogy-editions/:editionId/historical-projection", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const editionId = context.req.param("editionId");
    const edition = await context.env.DB.prepare("SELECT id FROM genealogy_edition WHERE id = ? AND retired_at IS NULL").bind(editionId).first<{ id: string }>();
    if (!edition) return context.json({ code: "edition_not_found" }, 404);
    const claims = await context.env.DB.prepare(
      "SELECT c.id, c.subject_record_id, c.related_record_id, c.relation_kind, c.raw_text, s.name_text AS subject_name, r.name_text AS related_name FROM source_relation_claim c LEFT JOIN source_person_record s ON s.id = c.subject_record_id LEFT JOIN source_person_record r ON r.id = c.related_record_id WHERE c.edition_id = ? AND c.retracted_at IS NULL ORDER BY c.created_at, c.id",
    ).bind(editionId).all();
    return context.json({ view: "historical", editionId, relationClaims: claims.results });
  });

  app.post("/api/admin/lineages/:lineageId/revisions/publish", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = publishRevisionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId");
    const base = await context.env.DB.prepare(
      "SELECT s.parent_person_id, s.child_person_id FROM lineage_published_pointer p JOIN lineage_succession_snapshot s ON s.revision_id = p.revision_id WHERE p.lineage_id = ? ORDER BY s.order_key",
    ).bind(lineageId).all<SuccessionRow>();
    const result = await publishSuccessionRevision(context.env.DB, {
      lineageId, revisionId: parsed.data.revisionId, basedOnRevisionId: parsed.data.basedOnRevisionId,
      baseEdges: base.results.map((row) => ({ parentPersonId: row.parent_person_id, childPersonId: row.child_person_id })),
      proposedEdges: parsed.data.edges, expectedPointerVersion: parsed.data.expectedPointerVersion, now: now(),
    }).catch((error: unknown) => {
      if (error instanceof Error && /lineage publish conflict/.test(error.message)) return null;
      throw error;
    });
    if (!result) return context.json({ code: "revision_conflict" }, 409);
    if (!result.published) return context.json({ code: "revision_invalid", issues: result.issues }, 400);
    await writeAudit(context.env.DB, auth.accountId, "lineage.revision_published", "lineage_revision", result.revisionId, { lineageId });
    return context.json(result, 201);
  });

  app.post("/api/admin/lineages/:lineageId/revisions/rollback", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = rollbackRevisionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId");
    try {
      const result = await rollbackSuccessionRevision(context.env.DB, {
        lineageId, targetRevisionId: parsed.data.targetRevisionId, newRevisionId: parsed.data.newRevisionId,
        expectedPointerVersion: parsed.data.expectedPointerVersion, now: now(),
      });
      if (!result.published) return context.json({ code: "revision_invalid", issues: result.issues }, 400);
      await writeAudit(context.env.DB, auth.accountId, "lineage.revision_rolled_back", "lineage_revision", result.revisionId, { lineageId, targetRevisionId: parsed.data.targetRevisionId });
      return context.json(result, 201);
    } catch (error) {
      if (error instanceof Error && /Rollback target|no published revision/.test(error.message)) {
        return context.json({ code: "rollback_unavailable" }, 409);
      }
      if (error instanceof Error && /lineage publish conflict/.test(error.message)) return context.json({ code: "revision_conflict" }, 409);
      throw error;
    }
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

  app.get("/api/admin/persons", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const query = context.req.query("query")?.trim() ?? "";
    const rows = await context.env.DB
      .prepare(
        `SELECT id, display_name, visibility FROM person
         WHERE display_name LIKE ? ESCAPE '\\'
         ORDER BY display_name ASC LIMIT 30`,
      )
      .bind(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`)
      .all<PersonAnchorRow>();
    return context.json({ persons: rows.results });
  });

  app.post("/api/admin/persons", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = personAnchorInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = crypto.randomUUID();
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB
        .prepare("INSERT INTO person (id, display_name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, parsed.data.displayName, parsed.data.visibility, timestamp, timestamp),
      context.env.DB
        .prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), auth.accountId, "person.anchor_created", "person", id, JSON.stringify({ visibility: parsed.data.visibility }), timestamp),
    ]);
    return context.json({ person: { id, displayName: parsed.data.displayName, visibility: parsed.data.visibility } }, 201);
  });

  app.post("/api/admin/persons/:personId/names", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = personNameInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const personId = context.req.param("personId");
    const person = await context.env.DB.prepare("SELECT id FROM person WHERE id = ?").bind(personId).first<{ id: string }>();
    if (!person) return context.json({ code: "person_not_found" }, 404);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      ...(parsed.data.isPrimary ? [context.env.DB.prepare("UPDATE person_name SET is_primary = 0 WHERE person_id = ? AND retired_at IS NULL").bind(personId)] : []),
      context.env.DB.prepare("INSERT INTO person_name (id, person_id, name_text, name_kind, is_primary, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, personId, parsed.data.nameText, parsed.data.nameKind, Number(parsed.data.isPrimary), parsed.data.visibility, timestamp),
      ...(parsed.data.isPrimary ? [context.env.DB.prepare("UPDATE person SET display_name = ?, updated_at = ? WHERE id = ?").bind(parsed.data.nameText, timestamp, personId)] : []),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.name_added", "person_name", id, JSON.stringify({ personId, isPrimary: parsed.data.isPrimary }), timestamp),
    ]);
    return context.json({ personName: { id, personId, nameText: parsed.data.nameText, nameKind: parsed.data.nameKind, isPrimary: parsed.data.isPrimary, visibility: parsed.data.visibility } }, 201);
  });

  app.post("/api/admin/persons/:personId/facts", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = personFactInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const personId = context.req.param("personId");
    const person = await context.env.DB.prepare("SELECT id FROM person WHERE id = ?").bind(personId).first<{ id: string }>();
    if (!person) return context.json({ code: "person_not_found" }, 404);
    if (parsed.data.placeId) {
      const place = await context.env.DB.prepare("SELECT id FROM place WHERE id = ? AND retired_at IS NULL").bind(parsed.data.placeId).first<{ id: string }>();
      if (!place) return context.json({ code: "place_not_found" }, 404);
    }
    const id = crypto.randomUUID(); const placeId = parsed.data.placeId ?? (parsed.data.placeName ? crypto.randomUUID() : null); const timestamp = now();
    await context.env.DB.batch([
      ...(parsed.data.placeName ? [context.env.DB.prepare("INSERT INTO place (id, name_text, place_kind, created_at) VALUES (?, ?, ?, ?)").bind(placeId, parsed.data.placeName, parsed.data.placeKind ?? "unknown", timestamp)] : []),
      context.env.DB.prepare("INSERT INTO person_fact (id, person_id, fact_kind, value_text, date_text, date_precision, place_id, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, personId, parsed.data.factKind, parsed.data.valueText ?? null, parsed.data.dateText ?? null, parsed.data.datePrecision, placeId, parsed.data.visibility, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.fact_added", "person_fact", id, JSON.stringify({ personId, factKind: parsed.data.factKind }), timestamp),
    ]);
    return context.json({ personFact: { id, personId, factKind: parsed.data.factKind, valueText: parsed.data.valueText ?? null, dateText: parsed.data.dateText ?? null, datePrecision: parsed.data.datePrecision, placeId, visibility: parsed.data.visibility } }, 201);
  });

  app.get("/api/admin/persons/:personId", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const personId = context.req.param("personId");
    const person = await context.env.DB.prepare("SELECT id, display_name, visibility FROM person WHERE id = ?").bind(personId).first<PersonAnchorRow>();
    if (!person) return context.json({ code: "person_not_found" }, 404);
    const [names, facts] = await Promise.all([
      context.env.DB.prepare("SELECT id, name_text, name_kind, is_primary, visibility FROM person_name WHERE person_id = ? AND retired_at IS NULL ORDER BY is_primary DESC, created_at, id").bind(personId).all(),
      context.env.DB.prepare("SELECT f.id, f.fact_kind, f.value_text, f.date_text, f.date_precision, f.visibility, f.place_id, p.name_text AS place_name FROM person_fact f LEFT JOIN place p ON p.id = f.place_id AND p.retired_at IS NULL WHERE f.person_id = ? AND f.retired_at IS NULL ORDER BY f.created_at, f.id").bind(personId).all(),
    ]);
    return context.json({ person: { id: person.id, displayName: person.display_name, visibility: person.visibility }, names: names.results, facts: facts.results });
  });

  app.post("/api/admin/person-names/:nameId/retire", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const nameId = context.req.param("nameId");
    const name = await context.env.DB.prepare("SELECT person_id, is_primary FROM person_name WHERE id = ? AND retired_at IS NULL").bind(nameId).first<{ person_id: string; is_primary: number }>();
    if (!name) return context.json({ code: "person_name_not_found" }, 404);
    if (name.is_primary) return context.json({ code: "primary_name_requires_replacement" }, 409);
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE person_name SET retired_at = ? WHERE id = ? AND retired_at IS NULL").bind(now(), nameId),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.name_retired", "person_name", nameId, JSON.stringify({ personId: name.person_id }), now()),
    ]);
    return context.json({ status: "retired" });
  });

  app.post("/api/admin/person-facts/:factId/retire", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const factId = context.req.param("factId");
    const fact = await context.env.DB.prepare("SELECT person_id FROM person_fact WHERE id = ? AND retired_at IS NULL").bind(factId).first<{ person_id: string }>();
    if (!fact) return context.json({ code: "person_fact_not_found" }, 404);
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE person_fact SET retired_at = ? WHERE id = ? AND retired_at IS NULL").bind(timestamp, factId),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.fact_retired", "person_fact", factId, JSON.stringify({ personId: fact.person_id }), timestamp),
    ]);
    return context.json({ status: "retired" });
  });

  app.get("/api/admin/places", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const query = context.req.query("query")?.trim() ?? "";
    const rows = await context.env.DB.prepare("SELECT id, name_text, parent_place_id, place_kind FROM place WHERE retired_at IS NULL AND name_text LIKE ? ESCAPE '\\' ORDER BY name_text LIMIT 30").bind(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`).all();
    return context.json({ places: rows.results });
  });

  app.post("/api/admin/places/:placeId/retire", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const placeId = context.req.param("placeId");
    const place = await context.env.DB.prepare("SELECT id FROM place WHERE id = ? AND retired_at IS NULL").bind(placeId).first<{ id: string }>();
    if (!place) return context.json({ code: "place_not_found" }, 404);
    const use = await context.env.DB.prepare("SELECT 1 FROM person_fact WHERE place_id = ? AND retired_at IS NULL LIMIT 1").bind(placeId).first();
    if (use) return context.json({ code: "place_in_use" }, 409);
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE place SET retired_at = ? WHERE id = ? AND retired_at IS NULL").bind(timestamp, placeId),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "place.retired", "place", placeId, "{}", timestamp),
    ]);
    return context.json({ status: "retired" });
  });

  app.post("/api/admin/genealogies", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = genealogyInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO genealogy (id, title, created_at) VALUES (?, ?, ?)").bind(id, parsed.data.title, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "source.genealogy_created", "genealogy", id, "{}", timestamp),
    ]);
    return context.json({ genealogy: { id, title: parsed.data.title } }, 201);
  });

  app.post("/api/admin/genealogies/:genealogyId/editions", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = genealogyEditionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const genealogyId = context.req.param("genealogyId");
    const genealogy = await context.env.DB.prepare("SELECT id FROM genealogy WHERE id = ? AND retired_at IS NULL").bind(genealogyId).first<{ id: string }>();
    if (!genealogy) return context.json({ code: "genealogy_not_found" }, 404);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO genealogy_edition (id, genealogy_id, title, edition_label, supersedes_edition_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, genealogyId, parsed.data.title, parsed.data.editionLabel ?? null, parsed.data.supersedesEditionId ?? null, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "source.edition_created", "genealogy_edition", id, JSON.stringify({ genealogyId }), timestamp),
    ]);
    return context.json({ edition: { id, genealogyId, title: parsed.data.title, editionLabel: parsed.data.editionLabel ?? null } }, 201);
  });

  app.post("/api/admin/genealogy-editions/:editionId/source-person-records", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = sourcePersonRecordInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const editionId = context.req.param("editionId");
    const edition = await context.env.DB.prepare("SELECT id FROM genealogy_edition WHERE id = ? AND retired_at IS NULL").bind(editionId).first<{ id: string }>();
    if (!edition) return context.json({ code: "edition_not_found" }, 404);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO source_person_record (id, edition_id, source_key, name_text, raw_text, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, editionId, parsed.data.sourceKey ?? null, parsed.data.nameText ?? null, parsed.data.rawText, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "source.person_record_created", "source_person_record", id, JSON.stringify({ editionId }), timestamp),
    ]);
    return context.json({ sourcePersonRecord: { id, editionId, sourceKey: parsed.data.sourceKey ?? null, nameText: parsed.data.nameText ?? null, rawText: parsed.data.rawText } }, 201);
  });

  app.post("/api/admin/source-person-records/:sourceRecordId/links", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = sourcePersonLinkInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const sourceRecordId = context.req.param("sourceRecordId");
    const [record, person] = await Promise.all([
      context.env.DB.prepare("SELECT id FROM source_person_record WHERE id = ?").bind(sourceRecordId).first<{ id: string }>(),
      context.env.DB.prepare("SELECT id FROM person WHERE id = ?").bind(parsed.data.personId).first<{ id: string }>(),
    ]);
    if (!record) return context.json({ code: "source_record_not_found" }, 404);
    if (!person) return context.json({ code: "person_not_found" }, 404);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE source_person_link SET status = 'revoked', revoked_at = ? WHERE source_record_id = ? AND status = 'confirmed' AND revoked_at IS NULL").bind(timestamp, sourceRecordId),
      context.env.DB.prepare("INSERT INTO source_person_link (id, source_record_id, person_id, status, linked_by_account_id, created_at) VALUES (?, ?, ?, 'confirmed', ?, ?)").bind(id, sourceRecordId, parsed.data.personId, auth.accountId, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "source.person_link_confirmed", "source_person_link", id, JSON.stringify({ sourceRecordId, personId: parsed.data.personId }), timestamp),
    ]);
    return context.json({ sourcePersonLink: { id, sourceRecordId, personId: parsed.data.personId, status: "confirmed" } }, 201);
  });

  app.post("/api/admin/genealogy-editions/:editionId/source-fact-claims", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = sourceFactClaimInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const editionId = context.req.param("editionId");
    const edition = await context.env.DB.prepare("SELECT id FROM genealogy_edition WHERE id = ? AND retired_at IS NULL").bind(editionId).first<{ id: string }>();
    if (!edition) return context.json({ code: "edition_not_found" }, 404);
    if (parsed.data.subjectRecordId) {
      const subject = await context.env.DB.prepare("SELECT id FROM source_person_record WHERE id = ? AND edition_id = ?").bind(parsed.data.subjectRecordId, editionId).first<{ id: string }>();
      if (!subject) return context.json({ code: "source_record_not_found" }, 404);
    }
    if (parsed.data.supersedesClaimId) {
      const previous = await context.env.DB.prepare("SELECT id FROM source_fact_claim WHERE id = ? AND edition_id = ? AND retracted_at IS NULL").bind(parsed.data.supersedesClaimId, editionId).first<{ id: string }>();
      if (!previous) return context.json({ code: "source_claim_not_found" }, 404);
    }
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO source_fact_claim (id, edition_id, subject_record_id, fact_kind, raw_text, created_at, supersedes_claim_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, editionId, parsed.data.subjectRecordId ?? null, parsed.data.factKind, parsed.data.rawText, timestamp, parsed.data.supersedesClaimId ?? null),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "source.fact_claim_created", "source_fact_claim", id, JSON.stringify({ editionId }), timestamp),
    ]);
    return context.json({ sourceFactClaim: { id, editionId, subjectRecordId: parsed.data.subjectRecordId ?? null, factKind: parsed.data.factKind, rawText: parsed.data.rawText, supersedesClaimId: parsed.data.supersedesClaimId ?? null } }, 201);
  });

  app.post("/api/admin/genealogy-editions/:editionId/source-relation-claims", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = sourceRelationClaimInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const editionId = context.req.param("editionId");
    const edition = await context.env.DB.prepare("SELECT id FROM genealogy_edition WHERE id = ? AND retired_at IS NULL").bind(editionId).first<{ id: string }>();
    if (!edition) return context.json({ code: "edition_not_found" }, 404);
    const records = [parsed.data.subjectRecordId, parsed.data.relatedRecordId].filter((id): id is string => Boolean(id));
    for (const recordId of records) {
      const record = await context.env.DB.prepare("SELECT id FROM source_person_record WHERE id = ? AND edition_id = ?").bind(recordId, editionId).first<{ id: string }>();
      if (!record) return context.json({ code: "source_record_not_found" }, 404);
    }
    if (parsed.data.supersedesClaimId) {
      const previous = await context.env.DB.prepare("SELECT id FROM source_relation_claim WHERE id = ? AND edition_id = ? AND retracted_at IS NULL").bind(parsed.data.supersedesClaimId, editionId).first<{ id: string }>();
      if (!previous) return context.json({ code: "source_claim_not_found" }, 404);
    }
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO source_relation_claim (id, edition_id, subject_record_id, related_record_id, relation_kind, raw_text, created_at, supersedes_claim_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, editionId, parsed.data.subjectRecordId, parsed.data.relatedRecordId ?? null, parsed.data.relationKind, parsed.data.rawText, timestamp, parsed.data.supersedesClaimId ?? null),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "source.relation_claim_created", "source_relation_claim", id, JSON.stringify({ editionId }), timestamp),
    ]);
    return context.json({ sourceRelationClaim: { id, editionId, subjectRecordId: parsed.data.subjectRecordId, relatedRecordId: parsed.data.relatedRecordId ?? null, relationKind: parsed.data.relationKind, rawText: parsed.data.rawText, supersedesClaimId: parsed.data.supersedesClaimId ?? null } }, 201);
  });

  app.get("/api/admin/genealogy-editions/:editionId/source-claims", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const editionId = context.req.param("editionId");
    const [facts, relations] = await Promise.all([
      context.env.DB.prepare("SELECT id, subject_record_id, fact_kind, raw_text, supersedes_claim_id, retracted_at FROM source_fact_claim WHERE edition_id = ? ORDER BY created_at, id").bind(editionId).all(),
      context.env.DB.prepare("SELECT id, subject_record_id, related_record_id, relation_kind, raw_text, supersedes_claim_id, retracted_at FROM source_relation_claim WHERE edition_id = ? ORDER BY created_at, id").bind(editionId).all(),
    ]);
    return context.json({ factClaims: facts.results, relationClaims: relations.results });
  });

  const retractSourceClaim = (table: "source_fact_claim" | "source_relation_claim", claimKind: "fact" | "relation") => async (context: Context<AppEnv>) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const claimId = context.req.param("claimId");
    if (!claimId) return context.json({ code: "not_found" }, 404);
    const timestamp = now();
    const result = await context.env.DB.prepare(`UPDATE ${table} SET retracted_at = ? WHERE id = ? AND retracted_at IS NULL`).bind(timestamp, claimId).run();
    if (result.meta.changes !== 1) return context.json({ code: "source_claim_not_found" }, 404);
    await writeAudit(context.env.DB, auth.accountId, "source.claim_retracted", table, claimId, { claimKind });
    return context.json({ status: "retracted" });
  };
  app.post("/api/admin/source-fact-claims/:claimId/retract", requireAuthentication, retractSourceClaim("source_fact_claim", "fact"));
  app.post("/api/admin/source-relation-claims/:claimId/retract", requireAuthentication, retractSourceClaim("source_relation_claim", "relation"));

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
    const roleIds = ["role-member", ...(input.role === "member" ? [] : [`role-${input.role}`])];
    const approvedAccount = "id = ? AND status = 'active' AND reviewed_at = ? AND reviewed_by_account_id = ? AND version = ?";
    const results = await context.env.DB.batch([
      context.env.DB
        .prepare(
          `UPDATE account SET status = 'active', reviewed_at = ?, reviewed_by_account_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'pending' AND version = ?`,
        )
        .bind(timestamp, auth.accountId, timestamp, accountId, input.version),
      ...roleIds.map((roleId) =>
        context.env.DB.prepare(
          `INSERT INTO account_role (account_id, role_id, granted_at, granted_by_account_id)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account WHERE ${approvedAccount})
           ON CONFLICT(account_id, role_id) DO NOTHING`,
        ).bind(accountId, roleId, timestamp, auth.accountId, accountId, timestamp, auth.accountId, input.version + 1),
      ),
      context.env.DB
        .prepare(
          `INSERT INTO account_person_link (account_id, person_id, linked_at, linked_by_account_id)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account WHERE ${approvedAccount})`,
        )
        .bind(accountId, input.personId, timestamp, auth.accountId, accountId, timestamp, auth.accountId, input.version + 1),
      context.env.DB
        .prepare(
          `INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account WHERE ${approvedAccount})`,
        )
        .bind(
          crypto.randomUUID(),
          auth.accountId,
          "account.approved",
          "account",
          accountId,
          JSON.stringify({ personId: input.personId, role: input.role }),
          timestamp,
          accountId,
          timestamp,
          auth.accountId,
          input.version + 1,
        ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      return context.json({ code: "review_conflict", message: "账号状态已变化，请刷新后重试。" }, 409);
    }
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

  app.onError((error, context) => {
    console.error(error);
    return context.json({
      code: "internal_error",
      ...(context.env.APP_ENV === "development" && error instanceof Error ? { message: error.message } : {}),
    }, 500);
  });
  app.notFound((context) => context.json({ code: "not_found" }, 404));

  return app;
}
