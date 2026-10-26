import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { canProposeForPeopleWithBranchMembership, canReadVisibility, hasPermission, type AccountScope } from "./auth/authorization";
import { consumeLoginRateLimit } from "./auth/login-rate-limit-store";
import { createOpaqueToken, hashOpaqueToken } from "./auth/opaque-token";
import { hashPassword, verifyPassword } from "./auth/password";
import { createLoginRateLimitKey } from "./auth/rate-limit";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./auth/session";
import {
  approvalInput,
  accountScopesInput,
  reviewerAssignmentInput,
  revokeReviewerAssignmentInput,
  bootstrapInput,
  loginInput,
  genealogyEditionInput,
  genealogyInput,
  lineageInput,
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
  sourceRelationSemanticRuleInput,
  successionEdgesInput,
  publishRevisionInput,
  rollbackRevisionInput,
  createChangeRequestInput,
  changeRequestVersionInput,
  rejectChangeRequestInput,
  publishChangeRequestInput,
  rollbackChangeRequestInput,
  mediaUploadIntentInput,
  mediaCleanupRunInput,
  backupWriteFreezeInput,
  backupWriteFreezeReleaseInput,
  personMediaInput,
  personMediaOrderInput,
  validationMessage,
} from "./auth/validation";
import { activeBackupWriteFreeze, backupWriteFreezeProtection } from "./backup/write-freeze";
import { createMediaUploadIntent, finalizeMediaUpload, retireMediaAsset } from "./media/media-asset";
import { cancelMediaCleanupRun, confirmMediaCleanupRun, expireMediaCleanupRun, freezeMediaCleanupRun, previewMediaCleanupItem, type CurrentMediaCleanupAsset, type FrozenMediaCleanupItem, type FrozenMediaCleanupRun, type MediaCleanupCandidate } from "./media/media-cleanup-run";
import { createR2PresignedPut, getR2PresignConfiguration } from "./media/r2-presigned-put";
import { previewSuccessionRevision } from "./lineage/revision-preview";
import { publishSuccessionRevision, rollbackSuccessionRevision } from "./lineage/revision-publish";
import { buildPublishedHangingChart } from "./lineage/hanging-chart-service";
import { projectHistoricalLineage } from "./lineage/historical-lineage-projection";
import { compareHistoricalLineage } from "./lineage/historical-lineage-comparison";
import { boundedKinship } from "./lineage/kinship-projection";
import { buildSnapshotChangeItems, buildSnapshotMembershipChangeItems, previewChangeRequest, type BranchMembershipCandidate, type BranchMembershipChangeItemCandidate, type ChangeItemCandidate } from "./lineage/change-request-preview";
import { previewBranchStructureChange, type BranchStructureCandidate, type BranchStructureChangeItemCandidate } from "./lineage/branch-structure-change-preview";
import { allowsDirectRevisionWrite } from "./lineage/publish-policy";
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
interface ChangeRequestRow { id: string; lineage_id: string; state: "draft" | "pending_review" | "approved" | "rejected" | "published" | "conflicted"; base_revision_id: string | null; base_pointer_version: number; created_by_account_id: string; version: number; discarded_at: string | null; }
interface ReviewerAssignmentRow { id: string; reviewer_account_id: string; }
interface ChangeItemRow { operation: ChangeItemCandidate["operation"]; subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" | null; }
interface MembershipRow { branch_id: string; person_id: string; membership_kind: BranchMembershipCandidate["membershipKind"]; }
interface MembershipChangeItemRow extends MembershipRow { operation: BranchMembershipChangeItemCandidate["operation"]; }
interface StructureRow { branch_id: string; parent_branch_id: string | null; name: string; branch_kind: BranchStructureCandidate["branchKind"]; retired_at: string | null; }
interface StructureChangeItemRow { operation: BranchStructureChangeItemCandidate["operation"]; branch_id: string; parent_branch_id: string | null; name: string; branch_kind: BranchStructureCandidate["branchKind"] | null; }
interface BranchMembershipSnapshotRow extends MembershipRow { display_name: string; }
interface BranchScopeCountRow { branch_id: string; account_scope_count: number; }
interface MediaAssetRow { id: string; object_key: string; sha256: string; byte_size: number; mime_type: "image/jpeg" | "image/png" | "image/webp"; original_filename: string; visibility: "PUBLIC" | "MEMBER" | "ADMIN"; state: "pending_upload" | "active" | "failed" | "retired"; created_by_account_id: string; created_at: string; upload_expires_at: string; }
interface MediaReadRow { id: string; object_key: string; mime_type: string; original_filename: string; visibility: "PUBLIC" | "MEMBER" | "ADMIN"; linked_visibility_rank: number | null; }
interface MediaCleanupPreviewRow { id: string; object_key: string; original_filename: string; mime_type: string; byte_size: number; sha256: string; retired_at: string; cleanup_after: string; retired_link_count: number; }
interface MediaCleanupRunRow { id: string; state: "pending_confirmation" | "confirmed" | "cancelled" | "expired"; candidate_snapshot_sha256: string; candidate_count: number; backup_recovery_point: string; backup_package_sha256: string; created_by_account_id: string; created_at: string; expires_at: string; confirmed_by_account_id: string | null; confirmed_at: string | null; cancelled_by_account_id: string | null; cancelled_at: string | null; }
interface MediaCleanupItemRow { id: string; media_asset_id: string; expected_object_key: string; expected_sha256: string; expected_byte_size: number; expected_retired_at: string; expected_cleanup_after: string; expected_historical_link_count: number; state: string; }
interface MediaCleanupPreflightRow extends MediaCleanupItemRow { current_state: string | null; current_object_key: string | null; current_sha256: string | null; current_byte_size: number | null; current_retired_at: string | null; current_cleanup_after: string | null; current_active_reference_count: number; current_historical_link_count: number; }

function now(): string {
  return new Date().toISOString();
}
function toHex(value: ArrayBuffer): string { return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

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

function changeItemPersonIds(items: readonly Pick<ChangeItemRow, "subject_person_id" | "related_person_id">[]): string[] {
  return [...new Set(items.flatMap((item) => [item.subject_person_id, item.related_person_id]))];
}

function toMembershipCandidates(rows: readonly MembershipRow[]): BranchMembershipCandidate[] {
  return rows.map((row) => ({ branchId: row.branch_id, personId: row.person_id, membershipKind: row.membership_kind }));
}

function toMembershipChangeCandidates(rows: readonly MembershipChangeItemRow[]): BranchMembershipChangeItemCandidate[] {
  return rows.map((row) => ({ operation: row.operation, branchId: row.branch_id, personId: row.person_id, membershipKind: row.membership_kind }));
}
function toStructureCandidates(rows: readonly StructureRow[]): BranchStructureCandidate[] { return rows.map((row) => ({ branchId: row.branch_id, parentBranchId: row.parent_branch_id, name: row.name, branchKind: row.branch_kind, retiredAt: row.retired_at })); }
function toStructureChangeCandidates(rows: readonly StructureChangeItemRow[]): BranchStructureChangeItemCandidate[] { return rows.map((row) => row.operation === "create" ? { operation: "create", branchId: row.branch_id, parentBranchId: row.parent_branch_id, name: row.name, branchKind: row.branch_kind! } : row.operation === "rename" ? { operation: "rename", branchId: row.branch_id, name: row.name } : { operation: "retire", branchId: row.branch_id }); }

function membershipItemsFitStructure(
  items: readonly Pick<MembershipChangeItemRow, "operation" | "branch_id">[],
  structures: ReturnType<typeof previewBranchStructureChange>["branches"],
): boolean {
  const branches = new Map(structures.map((branch) => [branch.branchId, branch]));
  return items.every((item) => {
    const branch = branches.get(item.branch_id);
    return branch && (item.operation === "remove" || branch.retiredAt === null);
  });
}

function membershipsUseActiveStructures(
  memberships: readonly BranchMembershipCandidate[],
  structures: ReturnType<typeof previewBranchStructureChange>["branches"],
): boolean {
  const branches = new Map(structures.map((branch) => [branch.branchId, branch]));
  return memberships.every((membership) => branches.get(membership.branchId)?.retiredAt === null);
}

async function structureRetirementsAreSafe(
  database: D1Database,
  memberships: readonly BranchMembershipCandidate[],
  structures: ReturnType<typeof previewBranchStructureChange>["branches"],
): Promise<boolean> {
  const retiredBranchIds = structures.filter((branch) => branch.retiredAt === "__PROPOSED_RETIREMENT__").map((branch) => branch.branchId);
  if (retiredBranchIds.length === 0) return true;
  if (memberships.some((membership) => retiredBranchIds.includes(membership.branchId))) return false;
  const scopes = await database.prepare(`SELECT scope_id FROM account_scope WHERE scope_type = 'branch' AND scope_id IN (${retiredBranchIds.map(() => "?").join(",")})`).bind(...retiredBranchIds).all<{ scope_id: string }>();
  return scopes.results.length === 0;
}

async function branchRetirementDependencies(
  database: D1Database,
  memberships: readonly BranchMembershipCandidate[],
  structures: ReturnType<typeof previewBranchStructureChange>["branches"],
) {
  const retiredBranchIds = structures.filter((branch) => branch.retiredAt === "__PROPOSED_RETIREMENT__").map((branch) => branch.branchId);
  if (retiredBranchIds.length === 0) return [];
  const scopeCounts = await database.prepare(
    `SELECT scope_id AS branch_id, COUNT(*) AS account_scope_count
     FROM account_scope WHERE scope_type = 'branch' AND scope_id IN (${retiredBranchIds.map(() => "?").join(",")})
     GROUP BY scope_id`,
  ).bind(...retiredBranchIds).all<BranchScopeCountRow>();
  const membershipCounts = new Map<string, number>();
  for (const membership of memberships) membershipCounts.set(membership.branchId, (membershipCounts.get(membership.branchId) ?? 0) + 1);
  const accountScopeCounts = new Map(scopeCounts.results.map((row) => [row.branch_id, row.account_scope_count]));
  return retiredBranchIds.map((branchId) => {
    const membershipCount = membershipCounts.get(branchId) ?? 0;
    const accountScopeCount = accountScopeCounts.get(branchId) ?? 0;
    return {
      branchId, membershipCount, accountScopeCount,
      blockingCodes: [
        ...(membershipCount > 0 ? ["branch_membership_in_use"] : []),
        ...(accountScopeCount > 0 ? ["branch_account_scope_in_use"] : []),
      ],
    };
  });
}

async function effectiveReviewerAssignments(database: D1Database, lineageId: string, timestamp: string, excludedAccountId: string): Promise<ReviewerAssignmentRow[]> {
  const rows = await database.prepare(
    `SELECT DISTINCT assignment.id, assignment.reviewer_account_id
     FROM lineage_reviewer_assignment assignment
     INNER JOIN account reviewer ON reviewer.id = assignment.reviewer_account_id AND reviewer.status = 'active'
     INNER JOIN account_role reviewer_role ON reviewer_role.account_id = reviewer.id
     INNER JOIN role ON role.id = reviewer_role.role_id AND role.name = 'admin'
     WHERE assignment.lineage_id = ? AND assignment.valid_from <= ? AND assignment.valid_until > ?
       AND assignment.revoked_at IS NULL AND assignment.reviewer_account_id <> ?`,
  ).bind(lineageId, timestamp, timestamp, excludedAccountId).all<ReviewerAssignmentRow>();
  return rows.results;
}

async function reviewerAssignmentAllows(database: D1Database, changeRequestId: string, reviewerAccountId: string, timestamp: string): Promise<boolean> {
  const snapshots = await database.prepare("SELECT reviewer_assignment_id FROM change_request_reviewer_assignment WHERE change_request_id = ?").bind(changeRequestId).all<{ reviewer_assignment_id: string }>();
  // Requests created before reviewer-assignment support have no snapshot and
  // retain the existing second-admin policy rather than being stranded.
  if (snapshots.results.length === 0) return true;
  const active = await database.prepare(
    `SELECT assignment.id
     FROM change_request_reviewer_assignment snapshot
     INNER JOIN lineage_reviewer_assignment assignment ON assignment.id = snapshot.reviewer_assignment_id
     INNER JOIN account reviewer ON reviewer.id = assignment.reviewer_account_id AND reviewer.status = 'active'
     INNER JOIN account_role reviewer_role ON reviewer_role.account_id = reviewer.id
     INNER JOIN role ON role.id = reviewer_role.role_id AND role.name = 'admin'
     WHERE snapshot.change_request_id = ? AND snapshot.reviewer_account_id = ?
       AND assignment.valid_from <= ? AND assignment.valid_until > ? AND assignment.revoked_at IS NULL
     LIMIT 1`,
  ).bind(changeRequestId, reviewerAccountId, timestamp, timestamp).first<{ id: string }>();
  return Boolean(active);
}

async function canProposeChangeForPeople(database: D1Database, auth: NonNullable<AppEnv["Variables"]["auth"]>, personIds: readonly string[], baseRevisionId: string | null): Promise<boolean> {
  if (hasPermission(auth.roles, "system.manage")) return true;
  const scopes = await database.prepare("SELECT scope_type, scope_id FROM account_scope WHERE account_id = ? ORDER BY scope_type, scope_id").bind(auth.accountId).all<{ scope_type: AccountScope["scopeType"]; scope_id: string | null }>();
  const normalizedScopes = scopes.results.map((scope) => ({ scopeType: scope.scope_type, scopeId: scope.scope_id }));
  const branchIds = normalizedScopes.filter((scope) => scope.scopeType === "branch" && scope.scopeId).map((scope) => scope.scopeId!);
  const memberships = baseRevisionId && branchIds.length > 0
    ? await database.prepare(`SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? AND membership_kind = 'blood_primary' AND branch_id IN (${branchIds.map(() => "?").join(",")})`).bind(baseRevisionId, ...branchIds).all<{ branch_id: string; person_id: string; membership_kind: "blood_primary" | "migration" | "administrative" }>()
    : { results: [] as Array<{ branch_id: string; person_id: string; membership_kind: "blood_primary" | "migration" | "administrative" }> };
  return canProposeForPeopleWithBranchMembership(
    auth.roles,
    normalizedScopes,
    personIds,
    memberships.results.map((membership) => ({ branchId: membership.branch_id, personId: membership.person_id, membershipKind: membership.membership_kind })),
  );
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
  app.use("/api/*", backupWriteFreezeProtection);

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

  app.get("/api/admin/media-assets/upload-availability", requireAuthentication, (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    return context.json({ available: getR2PresignConfiguration(context.env) !== null });
  });

  app.get("/api/admin/backup-write-freeze", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    return context.json({ freeze: await activeBackupWriteFreeze(context.env.DB) });
  });

  app.post("/api/admin/backup-write-freeze", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = backupWriteFreezeInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = crypto.randomUUID(); const timestamp = now();
    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO backup_write_freeze (id, reason, created_by_account_id, created_at) VALUES (?, ?, ?, ?)").bind(id, parsed.data.reason, auth.accountId, timestamp),
        context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "backup.write_freeze_started", "backup_write_freeze", id, JSON.stringify({ reason: parsed.data.reason }), timestamp),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) return context.json({ code: "backup_write_freeze_already_active" }, 409);
      throw error;
    }
    return context.json({ freeze: { id, reason: parsed.data.reason, createdByAccountId: auth.accountId, createdAt: timestamp } }, 201);
  });

  app.post("/api/admin/backup-write-freeze/release", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = backupWriteFreezeReleaseInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const timestamp = now();
    const result = await context.env.DB.prepare(
      "UPDATE backup_write_freeze SET released_by_account_id = ?, released_at = ?, release_reason = ? WHERE id = ? AND released_at IS NULL",
    ).bind(auth.accountId, timestamp, parsed.data.reason, parsed.data.freezeId).run();
    if (result.meta.changes !== 1) return context.json({ code: "backup_write_freeze_not_active" }, 409);
    await writeAudit(context.env.DB, auth.accountId, "backup.write_freeze_released", "backup_write_freeze", parsed.data.freezeId, { reason: parsed.data.reason });
    return context.body(null, 204);
  });

  app.post("/api/admin/media-assets/upload-intents", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = mediaUploadIntentInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const signingConfiguration = getR2PresignConfiguration(context.env);
    if (!signingConfiguration) return context.json({ code: "media_direct_upload_unavailable" }, 503);
    const intent = createMediaUploadIntent({ id: crypto.randomUUID(), createdByAccountId: auth.accountId, ...parsed.data }, new Date());
    let upload: Awaited<ReturnType<typeof createR2PresignedPut>>;
    try {
      upload = await createR2PresignedPut({ ...signingConfiguration, objectKey: intent.objectKey, mimeType: intent.mimeType, sha256: intent.sha256, issuedAt: new Date() });
    } catch {
      return context.json({ code: "media_direct_upload_unavailable" }, 503);
    }
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO media_asset (id, object_key, sha256, byte_size, mime_type, original_filename, visibility, state, created_by_account_id, created_at, upload_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(intent.id, intent.objectKey, intent.sha256, intent.byteSize, intent.mimeType, intent.originalFilename, intent.visibility, intent.state, intent.createdByAccountId, intent.createdAt, intent.uploadExpiresAt),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "media.upload_intent_created", "media_asset", intent.id, JSON.stringify({ mimeType: intent.mimeType, byteSize: intent.byteSize, visibility: intent.visibility }), intent.createdAt),
    ]);
    return context.json({ mediaAsset: intent, upload }, 201);
  });

  app.post("/api/admin/media-assets/:assetId/complete", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const asset = await context.env.DB.prepare("SELECT id, object_key, sha256, byte_size, mime_type, original_filename, visibility, state, created_by_account_id, created_at, upload_expires_at FROM media_asset WHERE id = ? AND created_by_account_id = ? AND state = 'pending_upload'").bind(context.req.param("assetId"), auth.accountId).first<MediaAssetRow>();
    if (!asset) return context.json({ code: "media_upload_intent_not_found" }, 404);
    const object = await context.env.MEDIA.head(asset.object_key);
    const uploaded = object ? { sha256: object.checksums.sha256 ? toHex(object.checksums.sha256) : "", byteSize: object.size, mimeType: object.httpMetadata?.contentType ?? "", etag: object.etag } : null;
    const finalized = finalizeMediaUpload({ id: asset.id, objectKey: asset.object_key, sha256: asset.sha256, byteSize: asset.byte_size, mimeType: asset.mime_type, originalFilename: asset.original_filename, visibility: asset.visibility, state: "pending_upload", createdByAccountId: asset.created_by_account_id, createdAt: asset.created_at, uploadExpiresAt: asset.upload_expires_at }, uploaded, new Date());
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE media_asset SET state = ?, finalized_at = ?, failed_at = ?, cleanup_after = ?, r2_etag = ? WHERE id = ? AND state = 'pending_upload'").bind(finalized.state, finalized.finalizedAt, finalized.failedAt, finalized.cleanupAfter, finalized.r2Etag, asset.id),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, finalized.state === "active" ? "media.upload_completed" : "media.upload_failed", "media_asset", asset.id, JSON.stringify({ objectPresent: object !== null }), now()),
    ]);
    if (finalized.state !== "active") return context.json({ code: "media_upload_verification_failed" }, 409);
    return context.json({ mediaAsset: finalized });
  });

  app.get("/api/media-assets/:assetId", async (context) => {
    const asset = await context.env.DB.prepare(
      `SELECT asset.id, asset.object_key, asset.mime_type, asset.original_filename, asset.visibility,
        MAX(CASE person.visibility WHEN 'ADMIN' THEN 2 WHEN 'MEMBER' THEN 1 ELSE 0 END) AS linked_visibility_rank
       FROM media_asset AS asset
       LEFT JOIN person_media AS link ON link.media_asset_id = asset.id AND link.retired_at IS NULL
       LEFT JOIN person ON person.id = link.person_id
       WHERE asset.id = ? AND asset.state = 'active'
       GROUP BY asset.id, asset.object_key, asset.mime_type, asset.original_filename, asset.visibility`,
    ).bind(context.req.param("assetId")).first<MediaReadRow>();
    if (!asset) return context.json({ code: "media_asset_not_found" }, 404);
    const assetVisibilityRank = asset.visibility === "ADMIN" ? 2 : asset.visibility === "MEMBER" ? 1 : 0;
    const effectiveVisibility = (["PUBLIC", "MEMBER", "ADMIN"] as const)[Math.max(assetVisibilityRank, asset.linked_visibility_rank ?? 0)]!;
    const auth = context.get("auth");
    if (!auth && effectiveVisibility !== "PUBLIC") return context.json({ code: "authentication_required" }, 401);
    if (auth && !canReadVisibility(auth.roles, effectiveVisibility)) return context.json({ code: "forbidden" }, 403);
    const object = await context.env.MEDIA.get(asset.object_key);
    if (!object) return context.json({ code: "media_object_missing" }, 409);
    return new Response(object.body, { headers: { "content-type": asset.mime_type, "content-disposition": `inline; filename="${asset.original_filename.replaceAll('"', "")}"`, "x-content-type-options": "nosniff" } });
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

  app.get("/api/admin/lineages", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const lineages = await context.env.DB.prepare(
      `SELECT lineage.id, lineage.name, lineage.succession_rule, pointer.revision_id AS published_revision_id, pointer.version AS pointer_version
       FROM lineage
       LEFT JOIN lineage_published_pointer AS pointer ON pointer.lineage_id = lineage.id
       WHERE lineage.retired_at IS NULL
       ORDER BY lineage.name, lineage.id
       LIMIT 100`,
    ).all();
    return context.json({ lineages: lineages.results });
  });

  app.get("/api/admin/lineages/:lineageId/branch-workbench", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const lineageId = context.req.param("lineageId");
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(lineageId).first<PublishedPointerRow>();
    if (!pointer) return context.json({ code: "published_revision_not_found" }, 404);
    const scopeCounts = await context.env.DB.prepare("SELECT scope_id AS branch_id, COUNT(*) AS account_scope_count FROM account_scope WHERE scope_type = 'branch' AND scope_id IS NOT NULL GROUP BY scope_id").all<BranchScopeCountRow>();
    const [structures, memberships] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch_structure_snapshot WHERE revision_id = ? ORDER BY parent_branch_id, name, branch_id").bind(pointer.revision_id),
      context.env.DB.prepare("SELECT membership.branch_id, membership.person_id, membership.membership_kind, person.display_name FROM branch_membership_snapshot AS membership INNER JOIN person ON person.id = membership.person_id WHERE membership.revision_id = ? ORDER BY membership.branch_id, membership.membership_kind, person.display_name, membership.person_id").bind(pointer.revision_id),
    ]);
    if (!structures || !memberships) throw new Error("branch workbench query did not return every result set");
    const membershipRows = memberships.results as BranchMembershipSnapshotRow[];
    const membershipCounts = new Map<string, number>();
    for (const membership of membershipRows) membershipCounts.set(membership.branch_id, (membershipCounts.get(membership.branch_id) ?? 0) + 1);
    const accountScopeCounts = new Map((scopeCounts.results as BranchScopeCountRow[]).map((row) => [row.branch_id, row.account_scope_count]));
    return context.json({
      lineageId, revisionId: pointer.revision_id, pointerVersion: pointer.version,
      branches: (structures.results as StructureRow[]).map((branch) => ({
        branchId: branch.branch_id, parentBranchId: branch.parent_branch_id, name: branch.name, branchKind: branch.branch_kind, retiredAt: branch.retired_at,
        membershipCount: membershipCounts.get(branch.branch_id) ?? 0,
        accountScopeCount: accountScopeCounts.get(branch.branch_id) ?? 0,
      })),
      memberships: membershipRows.map((membership) => ({ branchId: membership.branch_id, personId: membership.person_id, personDisplayName: membership.display_name, membershipKind: membership.membership_kind })),
    });
  });

  app.get("/api/admin/genealogy-editions", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const editions = await context.env.DB.prepare(
      `SELECT e.id, e.title, e.edition_label, g.id AS genealogy_id, g.title AS genealogy_title
       FROM genealogy_edition e INNER JOIN genealogy g ON g.id = e.genealogy_id
       WHERE e.retired_at IS NULL AND g.retired_at IS NULL ORDER BY g.title, e.created_at, e.id`,
    ).all();
    return context.json({ editions: editions.results });
  });

  app.post("/api/admin/lineages", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = lineageInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO lineage (id, name, created_at) VALUES (?, ?, ?)").bind(id, parsed.data.name, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.created", "lineage", id, "{}", timestamp),
    ]);
    return context.json({ lineage: { id, name: parsed.data.name, successionRule: "configured", publishedRevisionId: null, pointerVersion: null } }, 201);
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

  app.get("/api/admin/lineages/:lineageId/hanging-chart", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const lineageId = context.req.param("lineageId");
    const rootPersonId = context.req.query("rootPersonId");
    if (rootPersonId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(rootPersonId)) {
      return context.json({ code: "validation_failed", message: "rootPersonId 必须是 UUID。" }, 400);
    }
    const pointer = await context.env.DB.prepare(
      "SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?",
    ).bind(lineageId).first<PublishedPointerRow>();
    if (!pointer) return context.json({ code: "published_revision_not_found" }, 404);

    const edges = await context.env.DB.prepare(
      "SELECT parent_person_id, child_person_id, order_key FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key, id",
    ).bind(pointer.revision_id).all<{ parent_person_id: string; child_person_id: string; order_key: string }>();
    const people = await context.env.DB.prepare(
      `SELECT DISTINCT person.id, person.display_name
       FROM person
       INNER JOIN (
         SELECT parent_person_id AS person_id FROM lineage_succession_snapshot WHERE revision_id = ?
         UNION
         SELECT child_person_id AS person_id FROM lineage_succession_snapshot WHERE revision_id = ?
       ) AS projected_person ON projected_person.person_id = person.id
       ORDER BY person.id`,
    ).bind(pointer.revision_id, pointer.revision_id).all<{ id: string; display_name: string }>();
    if (rootPersonId && !people.results.some((person) => person.id === rootPersonId)) {
      return context.json({ code: "root_person_not_found" }, 404);
    }

    const chart = buildPublishedHangingChart(
      people.results.map((person) => ({ id: person.id, displayName: person.display_name })),
      edges.results.map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id, orderKey: edge.order_key })),
      rootPersonId,
    );
    return context.json({
      view: "canonical",
      lineageId,
      revisionId: pointer.revision_id,
      pointerVersion: pointer.version,
      ...chart,
    });
  });

  app.get("/api/admin/source-relation-semantics", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const rules = await context.env.DB.prepare(
      "SELECT id, relation_kind, graph_kind, parent_kind, created_at FROM source_relation_semantic_rule WHERE retired_at IS NULL ORDER BY relation_kind, id",
    ).all();
    return context.json({ rules: rules.results });
  });

  app.post("/api/admin/source-relation-semantics", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = sourceRelationSemanticRuleInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = crypto.randomUUID();
    const timestamp = now();
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          "INSERT INTO source_relation_semantic_rule (id, relation_kind, graph_kind, parent_kind, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(id, parsed.data.relationKind, parsed.data.graphKind, parsed.data.parentKind ?? null, timestamp),
        context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), auth.accountId, "source.relation_semantic_created", "source_relation_semantic_rule", id, JSON.stringify({ relationKind: parsed.data.relationKind }), timestamp),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return context.json({ code: "relation_semantic_exists" }, 409);
      throw error;
    }
    return context.json({ rule: { id, relationKind: parsed.data.relationKind, graphKind: parsed.data.graphKind, parentKind: parsed.data.parentKind ?? null } }, 201);
  });

  app.post("/api/admin/source-relation-semantics/:ruleId/retire", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const ruleId = context.req.param("ruleId");
    const result = await context.env.DB.prepare("UPDATE source_relation_semantic_rule SET retired_at = ? WHERE id = ? AND retired_at IS NULL").bind(now(), ruleId).run();
    if (result.meta.changes !== 1) return context.json({ code: "relation_semantic_not_found" }, 404);
    await writeAudit(context.env.DB, auth.accountId, "source.relation_semantic_retired", "source_relation_semantic_rule", ruleId, {});
    return context.json({ retired: true });
  });

  app.get("/api/admin/genealogy-editions/:editionId/historical-projection", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const editionId = context.req.param("editionId");
    const edition = await context.env.DB.prepare("SELECT id FROM genealogy_edition WHERE id = ? AND retired_at IS NULL").bind(editionId).first<{ id: string }>();
    if (!edition) return context.json({ code: "edition_not_found" }, 404);
    const maximumNodes = 100, maximumClaims = 200, rootRecordId = context.req.query("rootRecordId")?.trim();
    type HistoricalClaimRow = { id: string; subject_record_id: string; related_record_id: string | null; relation_kind: string; raw_text: string; created_at: string };
    const selectedIds = new Set<string>(), claimRows: HistoricalClaimRow[] = [];
    const byCreatedAt = (left: HistoricalClaimRow, right: HistoricalClaimRow) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
    let truncated = false;
    if (rootRecordId) {
      const root = await context.env.DB.prepare("SELECT id FROM source_person_record WHERE id = ? AND edition_id = ?").bind(rootRecordId, editionId).first<{ id: string }>();
      if (!root) return context.json({ code: "source_record_not_found" }, 404);
      selectedIds.add(root.id); let frontier = [root.id];
      for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
        const availableClaims = maximumClaims - claimRows.length + 1;
        const candidates = new Map<string, HistoricalClaimRow>();
        for (let start = 0; start < frontier.length; start += 48) {
          const chunk = frontier.slice(start, start + 48), placeholders = chunk.map(() => "?").join(",");
          const rows = await context.env.DB.prepare(`SELECT id, subject_record_id, related_record_id, relation_kind, raw_text, created_at FROM source_relation_claim WHERE edition_id = ? AND retracted_at IS NULL AND (subject_record_id IN (${placeholders}) OR related_record_id IN (${placeholders})) ORDER BY created_at, id LIMIT ?`).bind(editionId, ...chunk, ...chunk, availableClaims).all<HistoricalClaimRow>();
          rows.results.forEach((row) => candidates.set(row.id, row));
        }
        const rows = [...candidates.values()].sort(byCreatedAt).slice(0, availableClaims);
        if (rows.length > maximumClaims - claimRows.length) truncated = true;
        const next = new Set<string>();
        for (const row of rows) {
          if (claimRows.length >= maximumClaims) { truncated = true; break; }
          const endpoints: Array<string | null> = [row.subject_record_id, row.related_record_id];
          const additions = endpoints.filter((id): id is string => id !== null && !selectedIds.has(id));
          if (selectedIds.size + additions.length > maximumNodes) { truncated = true; continue; }
          additions.forEach((id) => { selectedIds.add(id); next.add(id); }); claimRows.push(row);
        }
        frontier = [...next].sort(); if (truncated) break;
      }
    } else {
      const records = await context.env.DB.prepare("SELECT id FROM source_person_record WHERE edition_id = ? ORDER BY created_at, id LIMIT ?").bind(editionId, maximumNodes + 1).all<{ id: string }>();
      if (records.results.length > maximumNodes) truncated = true;
      records.results.slice(0, maximumNodes).forEach((row) => selectedIds.add(row.id));
      if (selectedIds.size) {
        const candidates = new Map<string, HistoricalClaimRow>();
        const ids = [...selectedIds];
        for (let start = 0; start < ids.length; start += 97) {
          const chunk = ids.slice(start, start + 97), placeholders = chunk.map(() => "?").join(",");
          const claims = await context.env.DB.prepare(`SELECT id, subject_record_id, related_record_id, relation_kind, raw_text, created_at FROM source_relation_claim WHERE edition_id = ? AND retracted_at IS NULL AND subject_record_id IN (${placeholders}) ORDER BY created_at, id LIMIT ?`).bind(editionId, ...chunk, maximumClaims + 1).all<HistoricalClaimRow>();
          claims.results.filter((claim) => claim.related_record_id === null || selectedIds.has(claim.related_record_id)).forEach((claim) => candidates.set(claim.id, claim));
        }
        const claims = [...candidates.values()].sort(byCreatedAt);
        if (claims.length > maximumClaims) truncated = true;
        claimRows.push(...claims.slice(0, maximumClaims));
      }
    }
    const ids = [...selectedIds];
    if (ids.length === 0) return context.json({ view: "historical", editionId, rootRecordId: rootRecordId ?? null, truncated, relationClaims: [], projection: { nodes: [], parentChildEdges: [], spouseEdges: [], annotations: [] } });
    const recordCandidates: Array<{ id: string; name_text: string | null; person_id: string | null; created_at: string }> = [];
    for (let start = 0; start < ids.length; start += 90) {
      const chunk = ids.slice(start, start + 90);
      const records = await context.env.DB.prepare(`SELECT r.id, r.name_text, l.person_id, r.created_at FROM source_person_record r LEFT JOIN source_person_link l ON l.source_record_id = r.id AND l.status = 'confirmed' AND l.revoked_at IS NULL WHERE r.id IN (${chunk.map(() => "?").join(",")}) ORDER BY r.created_at, r.id`).bind(...chunk).all<{ id: string; name_text: string | null; person_id: string | null; created_at: string }>();
      recordCandidates.push(...records.results);
    }
    const rules = await context.env.DB.prepare("SELECT relation_kind, graph_kind, parent_kind FROM source_relation_semantic_rule WHERE retired_at IS NULL ORDER BY relation_kind, id").all<{ relation_kind: string; graph_kind: "parent_to_child" | "child_to_parent" | "spouse" | "non_graph"; parent_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | null }>();
    const recordRows = recordCandidates.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    const ruleRows = rules.results;
    const projection = projectHistoricalLineage(
      recordRows.map((record) => ({ id: record.id, displayName: record.name_text, confirmedPersonId: record.person_id })),
      claimRows.map((claim) => ({ id: claim.id, subjectRecordId: claim.subject_record_id, relatedRecordId: claim.related_record_id, relationKind: claim.relation_kind, rawText: claim.raw_text })),
      ruleRows.map((rule) => ({ relationKind: rule.relation_kind, graphKind: rule.graph_kind, parentKind: rule.parent_kind })),
    );
    return context.json({ view: "historical", editionId, rootRecordId: rootRecordId ?? null, truncated, relationClaims: claimRows.map((claim) => ({ id: claim.id, subject_record_id: claim.subject_record_id, related_record_id: claim.related_record_id, relation_kind: claim.relation_kind, raw_text: claim.raw_text })), projection });
  });

  app.get("/api/admin/lineages/:lineageId/historical-comparison", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const editionId = context.req.query("editionId");
    if (!editionId) return context.json({ code: "validation_failed", message: "editionId 必填。" }, 400);
    const lineageId = context.req.param("lineageId");
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(lineageId).first<PublishedPointerRow>();
    if (!pointer) return context.json({ code: "published_revision_not_found" }, 404);
    const edition = await context.env.DB.prepare("SELECT id FROM genealogy_edition WHERE id = ? AND retired_at IS NULL").bind(editionId).first<{ id: string }>();
    if (!edition) return context.json({ code: "edition_not_found" }, 404);
    const [canonical, records, claims, rules] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key, id").bind(pointer.revision_id),
      context.env.DB.prepare("SELECT r.id, r.name_text, l.person_id FROM source_person_record r LEFT JOIN source_person_link l ON l.source_record_id = r.id AND l.status = 'confirmed' AND l.revoked_at IS NULL WHERE r.edition_id = ? ORDER BY r.created_at, r.id").bind(editionId),
      context.env.DB.prepare("SELECT id, subject_record_id, related_record_id, relation_kind, raw_text FROM source_relation_claim WHERE edition_id = ? AND retracted_at IS NULL ORDER BY created_at, id").bind(editionId),
      context.env.DB.prepare("SELECT relation_kind, graph_kind, parent_kind FROM source_relation_semantic_rule WHERE retired_at IS NULL ORDER BY relation_kind, id"),
    ]);
    if (!canonical || !records || !claims || !rules) throw new Error("historical comparison query did not return every result set");
    const projection = projectHistoricalLineage(
      (records.results as Array<{ id: string; name_text: string | null; person_id: string | null }>).map((record) => ({ id: record.id, displayName: record.name_text, confirmedPersonId: record.person_id })),
      (claims.results as Array<{ id: string; subject_record_id: string; related_record_id: string | null; relation_kind: string; raw_text: string }>).map((claim) => ({ id: claim.id, subjectRecordId: claim.subject_record_id, relatedRecordId: claim.related_record_id, relationKind: claim.relation_kind, rawText: claim.raw_text })),
      (rules.results as Array<{ relation_kind: string; graph_kind: "parent_to_child" | "child_to_parent" | "spouse" | "non_graph"; parent_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | null }>).map((rule) => ({ relationKind: rule.relation_kind, graphKind: rule.graph_kind, parentKind: rule.parent_kind })),
    );
    const comparison = compareHistoricalLineage(
      (canonical.results as Array<{ parent_person_id: string; child_person_id: string }>).map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id })),
      projection,
    );
    return context.json({ view: "comparison", lineageId, editionId, revisionId: pointer.revision_id, pointerVersion: pointer.version, projection, comparison });
  });

  app.get("/api/admin/lineages/:lineageId/kinship", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const personId = context.req.query("personId");
    if (!personId) return context.json({ code: "validation_failed", message: "personId 必填。" }, 400);
    const radiusValue = context.req.query("radius") ?? "1";
    if (radiusValue !== "1" && radiusValue !== "2") return context.json({ code: "validation_failed", message: "radius 只能是 1 或 2。" }, 400);
    const radius = Number(radiusValue) as 1 | 2;
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(context.req.param("lineageId")).first<PublishedPointerRow>();
    if (!pointer) return context.json({ code: "published_revision_not_found" }, 404);
    const center = await context.env.DB.prepare("SELECT id, display_name FROM person WHERE id = ?").bind(personId).first<{ id: string; display_name: string }>();
    if (!center) return context.json({ code: "person_not_found" }, 404);
    const maximumNodes = 60, maximumRelations = 120;
    const nodes = new Map([[personId, 0]]), relationRows = new Map<string, { subjectPersonId: string; relatedPersonId: string; relationKind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" }>();
    let frontier = [personId], truncated = false;
    for (let distance = 0; distance < radius && frontier.length > 0; distance += 1) {
      const placeholders = frontier.map(() => "?").join(",");
      const availableRows = maximumRelations - relationRows.size + 1;
      const rows = await context.env.DB.prepare(
        `SELECT id, subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot
         WHERE revision_id = ? AND (subject_person_id IN (${placeholders}) OR related_person_id IN (${placeholders}))
         ORDER BY id LIMIT ?`,
      ).bind(pointer.revision_id, ...frontier, ...frontier, availableRows).all<{ id: string; subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" }>();
      if (rows.results.length === availableRows) truncated = true;
      const next = new Set<string>();
      for (const row of rows.results) {
        if (relationRows.has(row.id)) continue;
        if (relationRows.size >= maximumRelations) { truncated = true; continue; }
        const additions = [row.subject_person_id, row.related_person_id].filter((id) => !nodes.has(id));
        if (nodes.size + additions.length > maximumNodes) { truncated = true; continue; }
        relationRows.set(row.id, { subjectPersonId: row.subject_person_id, relatedPersonId: row.related_person_id, relationKind: row.relation_kind });
        for (const id of additions) { nodes.set(id, distance + 1); next.add(id); }
      }
      frontier = [...next].sort();
      if (truncated) break;
    }
    const ids = [...nodes.keys()];
    const people = await context.env.DB.prepare(`SELECT id, display_name FROM person WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all<{ id: string; display_name: string }>();
    if (people.results.length !== ids.length) return context.json({ code: "kinship_snapshot_inconsistent" }, 409);
    const graph = boundedKinship(personId, people.results.map((person) => ({ id: person.id, displayName: person.display_name })), [...relationRows.values()], radius, { nodes: maximumNodes, relations: maximumRelations });
    truncated ||= graph.truncated;
    return context.json({ view: "kinship", lineageId: context.req.param("lineageId"), revisionId: pointer.revision_id, pointerVersion: pointer.version, ...graph });
  });

  app.post("/api/admin/lineages/:lineageId/change-requests", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    const parsed = createChangeRequestInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId");
    const lineage = await context.env.DB.prepare("SELECT id FROM lineage WHERE id = ? AND retired_at IS NULL").bind(lineageId).first();
    if (!lineage) return context.json({ code: "lineage_not_found" }, 404);
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(lineageId).first<PublishedPointerRow>();
    if (parsed.data.membershipItems.length > 0 && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "membership_change_requires_admin" }, 403);
    if (parsed.data.structureItems.length > 0 && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "structure_change_requires_admin" }, 403);
    const scopeItems = parsed.data.items.map((item) => ({ subject_person_id: item.subjectPersonId, related_person_id: item.relatedPersonId }));
    const personIds = [...new Set([...changeItemPersonIds(scopeItems), ...parsed.data.membershipItems.map((item) => item.personId)])];
    const people = await context.env.DB.prepare(`SELECT id FROM person WHERE id IN (${personIds.map(() => "?").join(",")})`).bind(...personIds).all<{ id: string }>();
    if (people.results.length !== personIds.length) return context.json({ code: "change_person_not_found" }, 404);
    let structurePreview: ReturnType<typeof previewBranchStructureChange> | undefined;
    if (parsed.data.structureItems.length > 0) {
      const structures = pointer?.revision_id
        ? await context.env.DB.prepare("SELECT branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch_structure_snapshot WHERE revision_id = ?").bind(pointer.revision_id).all<StructureRow>()
        : await context.env.DB.prepare("SELECT id AS branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch WHERE lineage_id = ?").bind(lineageId).all<StructureRow>();
      structurePreview = previewBranchStructureChange(toStructureCandidates(structures.results), parsed.data.structureItems);
      if (!structurePreview.valid) return context.json({ code: "branch_structure_invalid", issues: structurePreview.issues }, 400);
    }
    if (parsed.data.membershipItems.length > 0) {
      const membershipItems = parsed.data.membershipItems.map((item) => ({ operation: item.operation, branch_id: item.branchId }));
      if (structurePreview) {
        if (!membershipItemsFitStructure(membershipItems, structurePreview.branches)) return context.json({ code: "change_branch_not_found_or_retired" }, 404);
      } else {
        const branchIds = [...new Set(parsed.data.membershipItems.map((item) => item.branchId))];
        const branches = await context.env.DB.prepare(`SELECT id FROM branch WHERE lineage_id = ? AND retired_at IS NULL AND id IN (${branchIds.map(() => "?").join(",")})`).bind(lineageId, ...branchIds).all<{ id: string }>();
        if (branches.results.length !== branchIds.length) return context.json({ code: "change_branch_not_found_or_retired" }, 404);
      }
    }
    if (!await canProposeChangeForPeople(context.env.DB, auth, personIds, pointer?.revision_id ?? null)) return context.json({ code: "scope_forbidden" }, 403);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO change_request (id, lineage_id, state, base_revision_id, base_pointer_version, reason, created_by_account_id, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)").bind(id, lineageId, pointer?.revision_id ?? null, pointer?.version ?? 0, parsed.data.reason, auth.accountId, timestamp),
      ...parsed.data.items.map((item) => context.env.DB.prepare("INSERT INTO change_item (id, change_request_id, operation, subject_person_id, related_person_id, relation_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, item.operation, item.subjectPersonId, item.relatedPersonId, item.relationKind ?? null, timestamp)),
      ...parsed.data.membershipItems.map((item) => context.env.DB.prepare("INSERT INTO branch_membership_change_item (id, change_request_id, operation, branch_id, person_id, membership_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, item.operation, item.branchId, item.personId, item.membershipKind, timestamp)),
      ...parsed.data.structureItems.map((item) => context.env.DB.prepare("INSERT INTO branch_structure_change_item (id, change_request_id, operation, branch_id, parent_branch_id, name, branch_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, item.operation, item.branchId, "parentBranchId" in item ? item.parentBranchId : null, "name" in item ? item.name : "", "branchKind" in item ? item.branchKind : null, timestamp)),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.change_request_created", "change_request", id, JSON.stringify({ lineageId, itemCount: parsed.data.items.length, membershipItemCount: parsed.data.membershipItems.length, structureItemCount: parsed.data.structureItems.length }), timestamp),
    ]);
    return context.json({ changeRequest: { id, lineageId, state: "draft", baseRevisionId: pointer?.revision_id ?? null, basePointerVersion: pointer?.version ?? 0, version: 1 } }, 201);
  });

  app.post("/api/admin/lineages/:lineageId/revisions/:revisionId/rollback-change-request", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = rollbackChangeRequestInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId"); const targetRevisionId = context.req.param("revisionId");
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(lineageId).first<PublishedPointerRow>();
    if (!pointer) return context.json({ code: "published_revision_not_found" }, 404);
    const target = await context.env.DB.prepare("SELECT id FROM lineage_revision WHERE id = ? AND lineage_id = ? AND state = 'published'").bind(targetRevisionId, lineageId).first();
    if (!target) return context.json({ code: "rollback_target_not_found" }, 404);
    const [baseEdges, baseRelations, targetEdges, targetRelations, baseMemberships, targetMemberships] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key").bind(pointer.revision_id),
      context.env.DB.prepare("SELECT subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot WHERE revision_id = ? ORDER BY id").bind(pointer.revision_id),
      context.env.DB.prepare("SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key").bind(targetRevisionId),
      context.env.DB.prepare("SELECT subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot WHERE revision_id = ? ORDER BY id").bind(targetRevisionId),
      context.env.DB.prepare("SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? ORDER BY branch_id, membership_kind, person_id, id").bind(pointer.revision_id),
      context.env.DB.prepare("SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? ORDER BY branch_id, membership_kind, person_id, id").bind(targetRevisionId),
    ]);
    if (!baseEdges || !baseRelations || !targetEdges || !targetRelations || !baseMemberships || !targetMemberships) throw new Error("rollback change request query did not return every result set");
    const toEdges = (rows: D1Result<unknown>) => (rows.results as SuccessionRow[]).map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id }));
    const toRelations = (rows: D1Result<unknown>) => (rows.results as Array<{ subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" }>).map((relation) => ({ subjectPersonId: relation.subject_person_id, relatedPersonId: relation.related_person_id, relationKind: relation.relation_kind }));
    const items = buildSnapshotChangeItems(toEdges(baseEdges), toRelations(baseRelations), toEdges(targetEdges), toRelations(targetRelations));
    const membershipItems = buildSnapshotMembershipChangeItems(toMembershipCandidates(baseMemberships.results as MembershipRow[]), toMembershipCandidates(targetMemberships.results as MembershipRow[]));
    if (items.length + membershipItems.length === 0) return context.json({ code: "rollback_not_needed" }, 409);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO change_request (id, lineage_id, state, base_revision_id, base_pointer_version, reason, created_by_account_id, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)").bind(id, lineageId, pointer.revision_id, pointer.version, parsed.data.reason, auth.accountId, timestamp),
      ...items.map((item) => context.env.DB.prepare("INSERT INTO change_item (id, change_request_id, operation, subject_person_id, related_person_id, relation_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, item.operation, item.subjectPersonId, item.relatedPersonId, "relationKind" in item ? item.relationKind : null, timestamp)),
      ...membershipItems.map((item) => context.env.DB.prepare("INSERT INTO branch_membership_change_item (id, change_request_id, operation, branch_id, person_id, membership_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, item.operation, item.branchId, item.personId, item.membershipKind, timestamp)),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.rollback_change_request_created", "change_request", id, JSON.stringify({ lineageId, targetRevisionId }), timestamp),
    ]);
    return context.json({ changeRequest: { id, lineageId, targetRevisionId, state: "draft", baseRevisionId: pointer.revision_id, basePointerVersion: pointer.version, version: 1, itemCount: items.length + membershipItems.length } }, 201);
  });

  app.get("/api/admin/change-requests/:changeRequestId/preview", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    const request = await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, created_by_account_id, version, discarded_at FROM change_request WHERE id = ?").bind(context.req.param("changeRequestId")).first<ChangeRequestRow>();
    if (!request) return context.json({ code: "change_request_not_found" }, 404);
    if (!hasPermission(auth.roles, "system.manage") && request.created_by_account_id !== auth.accountId) return context.json({ code: "forbidden" }, 403);
    const [edges, relations, items, memberships, membershipItems, structures, structureItems] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot WHERE revision_id = ? ORDER BY id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, subject_person_id, related_person_id, relation_kind FROM change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
      context.env.DB.prepare("SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? ORDER BY branch_id, membership_kind, person_id, id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, branch_id, person_id, membership_kind FROM branch_membership_change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
      context.env.DB.prepare("SELECT branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch_structure_snapshot WHERE revision_id = ? ORDER BY branch_id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, branch_id, parent_branch_id, name, branch_kind FROM branch_structure_change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
    ]);
    if (!edges || !relations || !items || !memberships || !membershipItems || !structures || !structureItems) throw new Error("change request preview query did not return every result set");
    const changeItems = items.results as ChangeItemRow[];
    if (!hasPermission(auth.roles, "system.manage") && !await canProposeChangeForPeople(context.env.DB, auth, changeItemPersonIds(changeItems), request.base_revision_id)) return context.json({ code: "scope_forbidden" }, 403);
    const preview = previewChangeRequest(
      (edges.results as SuccessionRow[]).map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id })),
      (relations.results as Array<{ subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" }>).map((relation) => ({ subjectPersonId: relation.subject_person_id, relatedPersonId: relation.related_person_id, relationKind: relation.relation_kind })),
      changeItems.map((item) => ({ operation: item.operation, subjectPersonId: item.subject_person_id, relatedPersonId: item.related_person_id, ...(item.relation_kind ? { relationKind: item.relation_kind } : {}) } as ChangeItemCandidate)),
      toMembershipCandidates(memberships.results as MembershipRow[]), toMembershipChangeCandidates(membershipItems.results as MembershipChangeItemRow[]),
    );
    const structurePreview = previewBranchStructureChange(toStructureCandidates(structures.results as StructureRow[]), toStructureChangeCandidates(structureItems.results as StructureChangeItemRow[]));
    const retirementDependencies = await branchRetirementDependencies(context.env.DB, preview.memberships, structurePreview.branches);
    const retirementIssues = retirementDependencies.filter((dependency) => dependency.blockingCodes.length > 0).map((dependency) => ({ code: "branch_retirement_in_use", branchIds: [dependency.branchId], blockingCodes: dependency.blockingCodes }));
    return context.json({ changeRequest: request, preview: { ...preview, valid: preview.valid && structurePreview.valid && retirementIssues.length === 0, issues: [...preview.issues, ...structurePreview.issues, ...retirementIssues], branchStructure: structurePreview, retirementDependencies } });
  });

  app.post("/api/admin/change-requests/:changeRequestId/discard", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    const parsed = changeRequestVersionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = context.req.param("changeRequestId");
    const request = await context.env.DB.prepare("SELECT id, state, created_by_account_id, version, discarded_at FROM change_request WHERE id = ?").bind(id).first<Pick<ChangeRequestRow, "id" | "state" | "created_by_account_id" | "version" | "discarded_at">>();
    if (!request || request.state !== "draft" || request.discarded_at !== null || request.version !== parsed.data.version) return context.json({ code: "change_request_conflict" }, 409);
    if (request.created_by_account_id !== auth.accountId) return context.json({ code: "forbidden" }, 403);
    const timestamp = now();
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE change_request SET discarded_at = ?, discarded_by_account_id = ?, version = version + 1 WHERE id = ? AND state = 'draft' AND discarded_at IS NULL AND version = ?").bind(timestamp, auth.accountId, id, parsed.data.version),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.change_request_discarded", "change_request", id, JSON.stringify({ previousVersion: parsed.data.version }), timestamp),
    ]);
    if (results[0]?.meta.changes !== 1) return context.json({ code: "change_request_conflict" }, 409);
    return context.json({ state: "discarded", version: parsed.data.version + 1 });
  });

  app.post("/api/admin/change-requests/:changeRequestId/submit", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    const parsed = changeRequestVersionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = context.req.param("changeRequestId"); const timestamp = now();
    const request = await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, created_by_account_id, version, discarded_at FROM change_request WHERE id = ?").bind(id).first<ChangeRequestRow>();
    if (!request || request.state !== "draft" || request.discarded_at !== null || request.version !== parsed.data.version) return context.json({ code: "change_request_conflict" }, 409);
    if (!hasPermission(auth.roles, "system.manage") && request.created_by_account_id !== auth.accountId) return context.json({ code: "forbidden" }, 403);
    const membershipItem = await context.env.DB.prepare("SELECT id FROM branch_membership_change_item WHERE change_request_id = ? LIMIT 1").bind(request.id).first();
    if (membershipItem && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "membership_change_requires_admin" }, 403);
    const structureItem = await context.env.DB.prepare("SELECT id FROM branch_structure_change_item WHERE change_request_id = ? LIMIT 1").bind(request.id).first();
    if (structureItem && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "structure_change_requires_admin" }, 403);
    if (!hasPermission(auth.roles, "system.manage")) {
      const items = await context.env.DB.prepare("SELECT operation, subject_person_id, related_person_id, relation_kind FROM change_item WHERE change_request_id = ? ORDER BY id").bind(request.id).all<ChangeItemRow>();
      if (!await canProposeChangeForPeople(context.env.DB, auth, changeItemPersonIds(items.results), request.base_revision_id)) return context.json({ code: "scope_forbidden" }, 403);
    }
    const reviewers = await effectiveReviewerAssignments(context.env.DB, request.lineage_id, timestamp, request.created_by_account_id);
    if (reviewers.length === 0) return context.json({ code: "reviewer_assignment_required", message: "该世系没有有效的非创建者审核人指派。" }, 409);
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE change_request SET state = 'pending_review', submitted_at = ?, version = version + 1 WHERE id = ? AND state = 'draft' AND discarded_at IS NULL AND version = ?").bind(timestamp, id, parsed.data.version),
      ...reviewers.map((reviewer) => context.env.DB.prepare("INSERT INTO change_request_reviewer_assignment (change_request_id, reviewer_assignment_id, reviewer_account_id, captured_at) VALUES (?, ?, ?, ?)").bind(id, reviewer.id, reviewer.reviewer_account_id, timestamp)),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.change_request_submitted", "change_request", id, JSON.stringify({ reviewerAssignmentIds: reviewers.map((reviewer) => reviewer.id) }), timestamp),
    ]);
    if (results[0]?.meta.changes !== 1) return context.json({ code: "change_request_conflict" }, 409);
    return context.json({ state: "pending_review" });
  });

  app.post("/api/admin/change-requests/:changeRequestId/approve", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "lineage.review")) return context.json({ code: "forbidden" }, 403);
    const parsed = changeRequestVersionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const request = await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, created_by_account_id, version FROM change_request WHERE id = ?").bind(context.req.param("changeRequestId")).first<ChangeRequestRow>();
    if (!request || request.state !== "pending_review" || request.version !== parsed.data.version) return context.json({ code: "change_request_conflict" }, 409);
    if (request.created_by_account_id === auth.accountId) return context.json({ code: "self_review_forbidden" }, 403);
    if (!await reviewerAssignmentAllows(context.env.DB, request.id, auth.accountId, now())) return context.json({ code: "reviewer_assignment_required" }, 403);
    const pointer = await context.env.DB.prepare("SELECT revision_id, version FROM lineage_published_pointer WHERE lineage_id = ?").bind(request.lineage_id).first<PublishedPointerRow>();
    if ((pointer?.revision_id ?? null) !== request.base_revision_id || (pointer?.version ?? 0) !== request.base_pointer_version) {
      const timestamp = now();
      await context.env.DB.batch([
        context.env.DB.prepare("UPDATE change_request SET state = 'conflicted', review_note = ?, reviewed_at = ?, reviewed_by_account_id = ?, version = version + 1 WHERE id = ? AND state = 'pending_review' AND version = ?").bind("发布基准已变化，请基于当前版本重新创建提案。", timestamp, auth.accountId, request.id, request.version),
        context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.change_request_conflicted", "change_request", request.id, JSON.stringify({ expectedPointerVersion: request.base_pointer_version, actualPointerVersion: pointer?.version ?? 0 }), timestamp),
      ]);
      return context.json({ code: "change_request_conflicted" }, 409);
    }
    const [edges, relations, items, memberships, membershipItems, structures, structureItems] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot WHERE revision_id = ? ORDER BY id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, subject_person_id, related_person_id, relation_kind FROM change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
      context.env.DB.prepare("SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? ORDER BY branch_id, membership_kind, person_id, id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, branch_id, person_id, membership_kind FROM branch_membership_change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
      context.env.DB.prepare("SELECT branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch_structure_snapshot WHERE revision_id = ? ORDER BY branch_id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, branch_id, parent_branch_id, name, branch_kind FROM branch_structure_change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
    ]);
    if (!edges || !relations || !items || !memberships || !membershipItems || !structures || !structureItems) throw new Error("change request approval query did not return every result set");
    if (membershipItems.results.length > 0 && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "membership_change_requires_admin" }, 403);
    if (structureItems.results.length > 0 && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "structure_change_requires_admin" }, 403);
    const preview = previewChangeRequest(
      (edges.results as SuccessionRow[]).map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id })),
      (relations.results as Array<{ subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" }>).map((relation) => ({ subjectPersonId: relation.subject_person_id, relatedPersonId: relation.related_person_id, relationKind: relation.relation_kind })),
      (items.results as ChangeItemRow[]).map((item) => ({ operation: item.operation, subjectPersonId: item.subject_person_id, relatedPersonId: item.related_person_id, ...(item.relation_kind ? { relationKind: item.relation_kind } : {}) } as ChangeItemCandidate)),
      toMembershipCandidates(memberships.results as MembershipRow[]), toMembershipChangeCandidates(membershipItems.results as MembershipChangeItemRow[]),
    );
    if (!preview.valid) return context.json({ code: "revision_invalid", issues: preview.issues }, 400);
    const structurePreview = previewBranchStructureChange(toStructureCandidates(structures.results as StructureRow[]), toStructureChangeCandidates(structureItems.results as StructureChangeItemRow[]));
    if (!structurePreview.valid) return context.json({ code: "branch_structure_invalid", issues: structurePreview.issues }, 400);
    if (!membershipItemsFitStructure(membershipItems.results as MembershipChangeItemRow[], structurePreview.branches)) return context.json({ code: "membership_branch_not_active" }, 409);
    if (!await structureRetirementsAreSafe(context.env.DB, preview.memberships, structurePreview.branches)) return context.json({ code: "branch_retirement_in_use" }, 409);
    if (!membershipsUseActiveStructures(preview.memberships, structurePreview.branches)) return context.json({ code: "membership_branch_not_active" }, 409);
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE change_request SET state = 'approved', reviewed_at = ?, reviewed_by_account_id = ?, version = version + 1 WHERE id = ? AND state = 'pending_review' AND version = ?").bind(now(), auth.accountId, request.id, request.version),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.change_request_approved", "change_request", request.id, "{}", now()),
    ]);
    return context.json({ state: "approved", version: request.version + 1 });
  });

  app.post("/api/admin/change-requests/:changeRequestId/reject", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "lineage.review")) return context.json({ code: "forbidden" }, 403);
    const parsed = rejectChangeRequestInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const id = context.req.param("changeRequestId"); const timestamp = now();
    const request = await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, created_by_account_id, version FROM change_request WHERE id = ?").bind(id).first<ChangeRequestRow>();
    if (!request || request.state !== "pending_review" || request.version !== parsed.data.version) return context.json({ code: "change_request_conflict" }, 409);
    if (request.created_by_account_id === auth.accountId) return context.json({ code: "self_review_forbidden" }, 403);
    const result = await context.env.DB.prepare("UPDATE change_request SET state = 'rejected', reviewed_at = ?, reviewed_by_account_id = ?, review_note = ?, version = version + 1 WHERE id = ? AND state = 'pending_review' AND version = ?").bind(timestamp, auth.accountId, parsed.data.reviewNote, id, parsed.data.version).run();
    if (result.meta.changes !== 1) return context.json({ code: "change_request_conflict" }, 409);
    await writeAudit(context.env.DB, auth.accountId, "lineage.change_request_rejected", "change_request", id, {});
    return context.json({ state: "rejected" });
  });

  app.post("/api/admin/change-requests/:changeRequestId/publish", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "lineage.review")) return context.json({ code: "forbidden" }, 403);
    const parsed = publishChangeRequestInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const request = await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, created_by_account_id, version FROM change_request WHERE id = ?").bind(context.req.param("changeRequestId")).first<ChangeRequestRow>();
    if (!request || request.state !== "approved" || request.version !== parsed.data.version) return context.json({ code: "change_request_conflict" }, 409);
    if (request.created_by_account_id === auth.accountId) return context.json({ code: "self_review_forbidden" }, 403);
    if (!await reviewerAssignmentAllows(context.env.DB, request.id, auth.accountId, now())) return context.json({ code: "reviewer_assignment_required" }, 403);
    const [edges, relations, items, memberships, membershipItems, structures, structureItems] = await context.env.DB.batch([
      context.env.DB.prepare("SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot WHERE revision_id = ? ORDER BY id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, subject_person_id, related_person_id, relation_kind FROM change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
      context.env.DB.prepare("SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? ORDER BY branch_id, membership_kind, person_id, id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, branch_id, person_id, membership_kind FROM branch_membership_change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
      context.env.DB.prepare("SELECT branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch_structure_snapshot WHERE revision_id = ? ORDER BY branch_id").bind(request.base_revision_id),
      context.env.DB.prepare("SELECT operation, branch_id, parent_branch_id, name, branch_kind FROM branch_structure_change_item WHERE change_request_id = ? ORDER BY id").bind(request.id),
    ]);
    if (!edges || !relations || !items || !memberships || !membershipItems || !structures || !structureItems) throw new Error("change request publish query did not return every result set");
    if (membershipItems.results.length > 0 && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "membership_change_requires_admin" }, 403);
    if (structureItems.results.length > 0 && !hasPermission(auth.roles, "system.manage")) return context.json({ code: "structure_change_requires_admin" }, 403);
    const preview = previewChangeRequest(
      (edges.results as SuccessionRow[]).map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id })),
      (relations.results as Array<{ subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" }>).map((relation) => ({ subjectPersonId: relation.subject_person_id, relatedPersonId: relation.related_person_id, relationKind: relation.relation_kind })),
      (items.results as Array<{ operation: ChangeItemCandidate["operation"]; subject_person_id: string; related_person_id: string; relation_kind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse" | null }>).map((item) => ({ operation: item.operation, subjectPersonId: item.subject_person_id, relatedPersonId: item.related_person_id, ...(item.relation_kind ? { relationKind: item.relation_kind } : {}) } as ChangeItemCandidate)),
      toMembershipCandidates(memberships.results as MembershipRow[]), toMembershipChangeCandidates(membershipItems.results as MembershipChangeItemRow[]),
    );
    if (!preview.valid) return context.json({ code: "revision_invalid", issues: preview.issues }, 400);
    const structurePreview = previewBranchStructureChange(toStructureCandidates(structures.results as StructureRow[]), toStructureChangeCandidates(structureItems.results as StructureChangeItemRow[]));
    if (!structurePreview.valid) return context.json({ code: "branch_structure_invalid", issues: structurePreview.issues }, 400);
    if (!membershipItemsFitStructure(membershipItems.results as MembershipChangeItemRow[], structurePreview.branches)) return context.json({ code: "membership_branch_not_active" }, 409);
    if (!await structureRetirementsAreSafe(context.env.DB, preview.memberships, structurePreview.branches)) return context.json({ code: "branch_retirement_in_use" }, 409);
    if (!membershipsUseActiveStructures(preview.memberships, structurePreview.branches)) return context.json({ code: "membership_branch_not_active" }, 409);
    const publishTime = now();
    const result = await publishSuccessionRevision(context.env.DB, {
      lineageId: request.lineage_id, revisionId: parsed.data.revisionId, basedOnRevisionId: request.base_revision_id ?? undefined,
      baseEdges: (edges.results as SuccessionRow[]).map((edge) => ({ parentPersonId: edge.parent_person_id, childPersonId: edge.child_person_id })),
      proposedEdges: preview.edges, proposedRelations: preview.relations, proposedBranchMemberships: preview.memberships.map((membership) => ({ branch_id: membership.branchId, person_id: membership.personId, membership_kind: membership.membershipKind })), proposedBranchStructures: structurePreview.branches.map((branch) => ({ branch_id: branch.branchId, parent_branch_id: branch.parentBranchId, name: branch.name, branch_kind: branch.branchKind, retired_at: branch.retiredAt === "__PROPOSED_RETIREMENT__" ? publishTime : branch.retiredAt })), branchStructureMutations: toStructureChangeCandidates(structureItems.results as StructureChangeItemRow[]), expectedPointerVersion: request.base_pointer_version, now: publishTime,
      changeRequest: { id: request.id, version: request.version },
      audit: { id: crypto.randomUUID(), actorAccountId: auth.accountId, action: "lineage.change_request_published", objectType: "change_request", objectId: request.id, metadataJson: JSON.stringify({ lineageId: request.lineage_id, revisionId: parsed.data.revisionId }) },
    }).catch((error: unknown) => {
      if (error instanceof Error && /(lineage publish conflict|change request publish conflict|UNIQUE constraint failed: lineage_revision.id)/.test(error.message)) return null;
      throw error;
    });
    if (!result) return context.json({ code: "change_request_conflicted" }, 409);
    if (!result.published) return context.json({ code: "revision_invalid", issues: result.issues }, 400);
    return context.json(result, 201);
  });

  app.post("/api/admin/lineages/:lineageId/revisions/publish", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (!allowsDirectRevisionWrite(context.env.APP_ENV)) return context.json({ code: "change_request_required", message: "正式环境必须通过变更提案发布世系。" }, 409);
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
      proposedRelations: parsed.data.relations,
      audit: {
        id: crypto.randomUUID(), actorAccountId: auth.accountId, action: "lineage.revision_published",
        objectType: "lineage_revision", objectId: parsed.data.revisionId, metadataJson: JSON.stringify({ lineageId }),
      },
    }).catch((error: unknown) => {
      if (error instanceof Error && /lineage publish conflict/.test(error.message)) return null;
      throw error;
    });
    if (!result) return context.json({ code: "revision_conflict" }, 409);
    if (!result.published) return context.json({ code: "revision_invalid", issues: result.issues }, 400);
    return context.json(result, 201);
  });

  app.post("/api/admin/lineages/:lineageId/revisions/rollback", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (!allowsDirectRevisionWrite(context.env.APP_ENV)) return context.json({ code: "change_request_required", message: "正式环境必须通过受控变更流程回退世系。" }, 409);
    const parsed = rollbackRevisionInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId");
    try {
      const result = await rollbackSuccessionRevision(context.env.DB, {
        lineageId, targetRevisionId: parsed.data.targetRevisionId, newRevisionId: parsed.data.newRevisionId,
        expectedPointerVersion: parsed.data.expectedPointerVersion, now: now(),
        audit: {
          id: crypto.randomUUID(), actorAccountId: auth.accountId, action: "lineage.revision_rolled_back",
          objectType: "lineage_revision", objectId: parsed.data.newRevisionId,
          metadataJson: JSON.stringify({ lineageId, targetRevisionId: parsed.data.targetRevisionId }),
        },
      });
      if (!result.published) return context.json({ code: "revision_invalid", issues: result.issues }, 400);
      return context.json(result, 201);
    } catch (error) {
      if (error instanceof Error && /Rollback target|no published revision/.test(error.message)) {
        return context.json({ code: "rollback_unavailable" }, 409);
      }
      if (error instanceof Error && /lineage publish conflict/.test(error.message)) return context.json({ code: "revision_conflict" }, 409);
      throw error;
    }
  });

  app.get("/api/admin/change-requests", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const lineageId = context.req.query("lineageId")?.trim();
    const rows = lineageId
      ? await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, reason, created_by_account_id, reviewed_by_account_id, review_note, version, created_at, submitted_at, reviewed_at, published_at, discarded_at, discarded_by_account_id FROM change_request WHERE lineage_id = ? ORDER BY created_at DESC, id DESC LIMIT 100").bind(lineageId).all()
      : await context.env.DB.prepare("SELECT id, lineage_id, state, base_revision_id, base_pointer_version, reason, created_by_account_id, reviewed_by_account_id, review_note, version, created_at, submitted_at, reviewed_at, published_at, discarded_at, discarded_by_account_id FROM change_request ORDER BY created_at DESC, id DESC LIMIT 100").all();
    return context.json({ changeRequests: rows.results });
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

  app.get("/api/admin/accounts/reviewers", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const rows = await context.env.DB.prepare(
      `SELECT DISTINCT account.id, account.username, account.display_name
       FROM account INNER JOIN account_role ON account_role.account_id = account.id
       INNER JOIN role ON role.id = account_role.role_id
       WHERE account.status = 'active' AND role.name = 'admin'
       ORDER BY account.display_name, account.username, account.id LIMIT 100`,
    ).all();
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

  app.get("/api/admin/media-assets", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const assets = await context.env.DB.prepare(
      `SELECT asset.id, asset.original_filename, asset.mime_type, asset.byte_size, asset.visibility, asset.finalized_at,
        COUNT(link.id) AS active_link_count
       FROM media_asset AS asset
       LEFT JOIN person_media AS link ON link.media_asset_id = asset.id AND link.retired_at IS NULL
       WHERE asset.state = 'active'
       GROUP BY asset.id, asset.original_filename, asset.mime_type, asset.byte_size, asset.visibility, asset.finalized_at
       ORDER BY asset.finalized_at DESC, asset.id DESC LIMIT 100`,
    ).all();
    return context.json({ mediaAssets: assets.results });
  });

  // This endpoint deliberately has no R2 operation, audit write, or state
  // transition. It is a bounded review list for a separately approved cleanup.
  app.get("/api/admin/media-assets/cleanup-preview", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const timestamp = now();
    const candidates = await context.env.DB.prepare(
      `SELECT asset.id, asset.object_key, asset.original_filename, asset.mime_type, asset.byte_size, asset.sha256, asset.retired_at, asset.cleanup_after,
        COUNT(history.id) AS retired_link_count
       FROM media_asset AS asset
       LEFT JOIN person_media AS history ON history.media_asset_id = asset.id AND history.retired_at IS NOT NULL
       WHERE asset.state = 'retired' AND asset.cleanup_after IS NOT NULL AND asset.cleanup_after <= ?
         AND NOT EXISTS (SELECT 1 FROM person_media AS active_link WHERE active_link.media_asset_id = asset.id AND active_link.retired_at IS NULL)
       GROUP BY asset.id, asset.object_key, asset.original_filename, asset.mime_type, asset.byte_size, asset.sha256, asset.retired_at, asset.cleanup_after
       ORDER BY asset.cleanup_after ASC, asset.id ASC LIMIT 100`,
    ).bind(timestamp).all<MediaCleanupPreviewRow>();
    return context.json({ asOf: timestamp, candidates: candidates.results });
  });

  app.post("/api/admin/media-cleanup-runs", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (context.env.APP_ENV !== "development") return context.json({ code: "media_cleanup_local_only" }, 403);
    const parsed = mediaCleanupRunInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const timestamp = new Date();
    const rows = await context.env.DB.prepare(
      `SELECT asset.id, asset.object_key, asset.sha256, asset.byte_size, asset.retired_at, asset.cleanup_after,
        COUNT(history.id) AS retired_link_count
       FROM media_asset AS asset
       LEFT JOIN person_media AS history ON history.media_asset_id = asset.id AND history.retired_at IS NOT NULL
       WHERE asset.state = 'retired' AND asset.cleanup_after IS NOT NULL AND asset.cleanup_after <= ?
         AND NOT EXISTS (SELECT 1 FROM person_media AS active_link WHERE active_link.media_asset_id = asset.id AND active_link.retired_at IS NULL)
       GROUP BY asset.id, asset.object_key, asset.sha256, asset.byte_size, asset.retired_at, asset.cleanup_after
       ORDER BY asset.cleanup_after ASC, asset.id ASC LIMIT 100`,
    ).bind(timestamp.toISOString()).all<MediaCleanupPreviewRow>();
    if (rows.results.length === 0) return context.json({ code: "media_cleanup_no_candidates" }, 409);
    let frozen: Awaited<ReturnType<typeof freezeMediaCleanupRun>>;
    try {
      frozen = await freezeMediaCleanupRun({
        id: crypto.randomUUID(), createdByAccountId: auth.accountId, ...parsed.data,
        candidates: rows.results.map((row): MediaCleanupCandidate => ({ mediaAssetId: row.id, objectKey: row.object_key, sha256: row.sha256, byteSize: row.byte_size, retiredAt: row.retired_at, cleanupAfter: row.cleanup_after, historicalLinkCount: row.retired_link_count })),
      }, timestamp);
    } catch {
      return context.json({ code: "media_cleanup_candidate_invalid" }, 409);
    }
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO media_cleanup_run (id, state, candidate_snapshot_sha256, candidate_count, backup_recovery_point, backup_package_sha256, created_by_account_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(frozen.run.id, frozen.run.state, frozen.run.candidateSnapshotSha256, frozen.run.candidateCount, frozen.run.backupRecoveryPoint, frozen.run.backupPackageSha256, frozen.run.createdByAccountId, frozen.run.createdAt, frozen.run.expiresAt),
      ...frozen.candidates.map((candidate) => context.env.DB.prepare("INSERT INTO media_cleanup_item (id, cleanup_run_id, media_asset_id, expected_object_key, expected_sha256, expected_byte_size, expected_retired_at, expected_cleanup_after, expected_historical_link_count, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?)").bind(crypto.randomUUID(), frozen.run.id, candidate.mediaAssetId, candidate.objectKey, candidate.sha256, candidate.byteSize, candidate.retiredAt, candidate.cleanupAfter, candidate.historicalLinkCount, frozen.run.createdAt)),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "media.cleanup_run_frozen", "media_cleanup_run", frozen.run.id, JSON.stringify({ candidateCount: frozen.run.candidateCount, candidateSnapshotSha256: frozen.run.candidateSnapshotSha256, backupRecoveryPoint: frozen.run.backupRecoveryPoint, backupPackageSha256: frozen.run.backupPackageSha256, localOnly: true }), frozen.run.createdAt),
    ]);
    return context.json({ cleanupRun: frozen.run }, 201);
  });

  app.get("/api/admin/media-cleanup-runs/:cleanupRunId", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (context.env.APP_ENV !== "development") return context.json({ code: "media_cleanup_local_only" }, 403);
    const run = await context.env.DB.prepare("SELECT id, state, candidate_snapshot_sha256, candidate_count, backup_recovery_point, backup_package_sha256, created_by_account_id, created_at, expires_at, confirmed_by_account_id, confirmed_at, cancelled_by_account_id, cancelled_at FROM media_cleanup_run WHERE id = ?").bind(context.req.param("cleanupRunId")).first<MediaCleanupRunRow>();
    if (!run) return context.json({ code: "media_cleanup_run_not_found" }, 404);
    const items = await context.env.DB.prepare("SELECT id, media_asset_id, expected_object_key, expected_sha256, expected_byte_size, expected_retired_at, expected_cleanup_after, expected_historical_link_count, state FROM media_cleanup_item WHERE cleanup_run_id = ? ORDER BY expected_cleanup_after, media_asset_id").bind(run.id).all<MediaCleanupItemRow>();
    return context.json({ cleanupRun: run, items: items.results });
  });

  app.get("/api/admin/media-cleanup-runs/:cleanupRunId/preflight", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (context.env.APP_ENV !== "development") return context.json({ code: "media_cleanup_local_only" }, 403);
    const run = await context.env.DB.prepare("SELECT id, state FROM media_cleanup_run WHERE id = ?").bind(context.req.param("cleanupRunId")).first<{ id: string; state: string }>();
    if (!run) return context.json({ code: "media_cleanup_run_not_found" }, 404);
    const timestamp = new Date();
    const rows = await context.env.DB.prepare(
      `SELECT item.id, item.media_asset_id, item.expected_object_key, item.expected_sha256, item.expected_byte_size, item.expected_retired_at, item.expected_cleanup_after, item.expected_historical_link_count, item.state,
        asset.state AS current_state, asset.object_key AS current_object_key, asset.sha256 AS current_sha256, asset.byte_size AS current_byte_size, asset.retired_at AS current_retired_at, asset.cleanup_after AS current_cleanup_after,
        (SELECT COUNT(*) FROM person_media AS active_link WHERE active_link.media_asset_id = item.media_asset_id AND active_link.retired_at IS NULL) AS current_active_reference_count,
        (SELECT COUNT(*) FROM person_media AS historical_link WHERE historical_link.media_asset_id = item.media_asset_id AND historical_link.retired_at IS NOT NULL) AS current_historical_link_count
       FROM media_cleanup_item AS item
       LEFT JOIN media_asset AS asset ON asset.id = item.media_asset_id
       WHERE item.cleanup_run_id = ?
       ORDER BY item.expected_cleanup_after, item.media_asset_id`,
    ).bind(run.id).all<MediaCleanupPreflightRow>();
    const items = rows.results.map((row) => {
      const frozen: FrozenMediaCleanupItem = { mediaAssetId: row.media_asset_id, expectedObjectKey: row.expected_object_key, expectedSha256: row.expected_sha256, expectedByteSize: row.expected_byte_size, expectedRetiredAt: row.expected_retired_at, expectedCleanupAfter: row.expected_cleanup_after, expectedHistoricalLinkCount: row.expected_historical_link_count };
      const current: CurrentMediaCleanupAsset | null = row.current_state === null || row.current_object_key === null || row.current_sha256 === null || row.current_byte_size === null
        ? null
        : { state: row.current_state, objectKey: row.current_object_key, sha256: row.current_sha256, byteSize: row.current_byte_size, retiredAt: row.current_retired_at, cleanupAfter: row.current_cleanup_after, activeReferenceCount: row.current_active_reference_count, historicalLinkCount: row.current_historical_link_count };
      return { itemId: row.id, mediaAssetId: row.media_asset_id, ...previewMediaCleanupItem(frozen, current, timestamp) };
    });
    return context.json({ asOf: timestamp.toISOString(), cleanupRunState: run.state, executionAvailable: false, items });
  });

  app.post("/api/admin/media-cleanup-runs/:cleanupRunId/confirm", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (context.env.APP_ENV !== "development") return context.json({ code: "media_cleanup_local_only" }, 403);
    const row = await context.env.DB.prepare("SELECT id, state, candidate_snapshot_sha256, candidate_count, backup_recovery_point, backup_package_sha256, created_by_account_id, created_at, expires_at, confirmed_by_account_id, confirmed_at, cancelled_by_account_id, cancelled_at FROM media_cleanup_run WHERE id = ?").bind(context.req.param("cleanupRunId")).first<MediaCleanupRunRow>();
    if (!row) return context.json({ code: "media_cleanup_run_not_found" }, 404);
    if (row.state !== "pending_confirmation") return context.json({ code: "media_cleanup_run_not_pending" }, 409);
    const frozenRun: FrozenMediaCleanupRun = { id: row.id, state: "pending_confirmation", candidateSnapshotSha256: row.candidate_snapshot_sha256, candidateCount: row.candidate_count, backupRecoveryPoint: row.backup_recovery_point, backupPackageSha256: row.backup_package_sha256, createdByAccountId: row.created_by_account_id, createdAt: row.created_at, expiresAt: row.expires_at };
    const timestamp = new Date();
    if (timestamp.getTime() >= Date.parse(frozenRun.expiresAt)) {
      expireMediaCleanupRun(frozenRun, timestamp);
      const expired = await context.env.DB.prepare("UPDATE media_cleanup_run SET state = 'expired' WHERE id = ? AND state = 'pending_confirmation' AND expires_at <= ?").bind(frozenRun.id, timestamp.toISOString()).run();
      if (expired.meta.changes === 1) await writeAudit(context.env.DB, auth.accountId, "media.cleanup_run_expired", "media_cleanup_run", frozenRun.id, { localOnly: true });
      return context.json({ code: "media_cleanup_run_expired" }, 409);
    }
    let confirmed: ReturnType<typeof confirmMediaCleanupRun>;
    try {
      confirmed = confirmMediaCleanupRun(frozenRun, auth.accountId, timestamp);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "media_cleanup_confirmation_invalid" }, 409);
    }
    const result = await context.env.DB.prepare("UPDATE media_cleanup_run SET state = 'confirmed', confirmed_by_account_id = ?, confirmed_at = ? WHERE id = ? AND state = 'pending_confirmation' AND confirmed_by_account_id IS NULL").bind(confirmed.confirmedByAccountId, confirmed.confirmedAt, confirmed.id).run();
    if (result.meta.changes !== 1) return context.json({ code: "media_cleanup_run_not_pending" }, 409);
    await writeAudit(context.env.DB, auth.accountId, "media.cleanup_run_confirmed", "media_cleanup_run", confirmed.id, { candidateSnapshotSha256: confirmed.candidateSnapshotSha256, confirmedByAccountId: auth.accountId, localOnly: true });
    return context.json({ cleanupRun: confirmed });
  });

  app.post("/api/admin/media-cleanup-runs/:cleanupRunId/cancel", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    if (context.env.APP_ENV !== "development") return context.json({ code: "media_cleanup_local_only" }, 403);
    const row = await context.env.DB.prepare("SELECT id, state, candidate_snapshot_sha256, candidate_count, backup_recovery_point, backup_package_sha256, created_by_account_id, created_at, expires_at, confirmed_by_account_id, confirmed_at, cancelled_by_account_id, cancelled_at FROM media_cleanup_run WHERE id = ?").bind(context.req.param("cleanupRunId")).first<MediaCleanupRunRow>();
    if (!row) return context.json({ code: "media_cleanup_run_not_found" }, 404);
    if (row.state !== "pending_confirmation") return context.json({ code: "media_cleanup_run_not_pending" }, 409);
    const cancelled = cancelMediaCleanupRun({ id: row.id, state: "pending_confirmation", candidateSnapshotSha256: row.candidate_snapshot_sha256, candidateCount: row.candidate_count, backupRecoveryPoint: row.backup_recovery_point, backupPackageSha256: row.backup_package_sha256, createdByAccountId: row.created_by_account_id, createdAt: row.created_at, expiresAt: row.expires_at }, auth.accountId, new Date());
    const result = await context.env.DB.prepare("UPDATE media_cleanup_run SET state = 'cancelled', cancelled_by_account_id = ?, cancelled_at = ? WHERE id = ? AND state = 'pending_confirmation' AND confirmed_by_account_id IS NULL").bind(cancelled.cancelledByAccountId, cancelled.cancelledAt, cancelled.id).run();
    if (result.meta.changes !== 1) return context.json({ code: "media_cleanup_run_not_pending" }, 409);
    await writeAudit(context.env.DB, auth.accountId, "media.cleanup_run_cancelled", "media_cleanup_run", cancelled.id, { localOnly: true });
    return context.json({ cleanupRun: cancelled });
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

  app.post("/api/admin/persons/:personId/media", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = personMediaInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const personId = context.req.param("personId");
    const [person, asset, existing] = await Promise.all([
      context.env.DB.prepare("SELECT id FROM person WHERE id = ?").bind(personId).first<{ id: string }>(),
      context.env.DB.prepare("SELECT id FROM media_asset WHERE id = ? AND state = 'active'").bind(parsed.data.mediaAssetId).first<{ id: string }>(),
      context.env.DB.prepare("SELECT id FROM person_media WHERE person_id = ? AND media_asset_id = ? AND retired_at IS NULL").bind(personId, parsed.data.mediaAssetId).first<{ id: string }>(),
    ]);
    if (!person) return context.json({ code: "person_not_found" }, 404);
    if (!asset) return context.json({ code: "media_asset_not_found" }, 404);
    if (existing) return context.json({ code: "person_media_already_linked" }, 409);
    const id = crypto.randomUUID(); const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO person_media (id, person_id, media_asset_id, role, display_order, caption, created_by_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, personId, parsed.data.mediaAssetId, parsed.data.role, parsed.data.displayOrder, parsed.data.caption ?? null, auth.accountId, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.media_linked", "person_media", id, JSON.stringify({ personId, mediaAssetId: parsed.data.mediaAssetId, role: parsed.data.role }), timestamp),
    ]);
    return context.json({ personMedia: { id, personId, mediaAssetId: parsed.data.mediaAssetId, role: parsed.data.role, displayOrder: parsed.data.displayOrder, caption: parsed.data.caption ?? null } }, 201);
  });

  app.get("/api/admin/persons/:personId/media", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const personId = context.req.param("personId");
    const person = await context.env.DB.prepare("SELECT id FROM person WHERE id = ?").bind(personId).first<{ id: string }>();
    if (!person) return context.json({ code: "person_not_found" }, 404);
    const links = await context.env.DB.prepare(
      `SELECT link.id, link.media_asset_id, link.role, link.display_order, link.caption, asset.original_filename, asset.mime_type, asset.visibility
       FROM person_media AS link INNER JOIN media_asset AS asset ON asset.id = link.media_asset_id
       WHERE link.person_id = ? AND link.retired_at IS NULL AND asset.state = 'active'
       ORDER BY link.display_order, link.created_at, link.id`,
    ).bind(personId).all();
    return context.json({ personMedia: links.results });
  });

  app.post("/api/admin/person-media/:personMediaId/order", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = personMediaOrderInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const link = await context.env.DB.prepare("SELECT person_id, media_asset_id FROM person_media WHERE id = ? AND retired_at IS NULL").bind(context.req.param("personMediaId")).first<{ person_id: string; media_asset_id: string }>();
    if (!link) return context.json({ code: "person_media_not_found" }, 404);
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE person_media SET display_order = ? WHERE id = ? AND retired_at IS NULL").bind(parsed.data.displayOrder, context.req.param("personMediaId")),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.media_reordered", "person_media", context.req.param("personMediaId"), JSON.stringify({ personId: link.person_id, mediaAssetId: link.media_asset_id, displayOrder: parsed.data.displayOrder }), timestamp),
    ]);
    return context.json({ personMedia: { id: context.req.param("personMediaId"), displayOrder: parsed.data.displayOrder } });
  });

  app.post("/api/admin/person-media/:personMediaId/retire", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const linkId = context.req.param("personMediaId");
    const link = await context.env.DB.prepare("SELECT link.person_id, link.media_asset_id, asset.state FROM person_media AS link INNER JOIN media_asset AS asset ON asset.id = link.media_asset_id WHERE link.id = ? AND link.retired_at IS NULL").bind(linkId).first<{ person_id: string; media_asset_id: string; state: "active" | "retired" }>();
    if (!link) return context.json({ code: "person_media_not_found" }, 404);
    const otherLinks = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM person_media WHERE media_asset_id = ? AND retired_at IS NULL AND id != ?").bind(link.media_asset_id, linkId).first<{ count: number }>();
    const timestamp = new Date();
    const retirement = link.state === "active" && otherLinks?.count === 0 ? retireMediaAsset("active", 0, timestamp) : null;
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE person_media SET retired_at = ? WHERE id = ? AND retired_at IS NULL").bind(timestamp.toISOString(), linkId),
      ...(retirement ? [context.env.DB.prepare("UPDATE media_asset SET state = 'retired', retired_at = ?, cleanup_after = ? WHERE id = ? AND state = 'active' AND NOT EXISTS (SELECT 1 FROM person_media WHERE media_asset_id = ? AND retired_at IS NULL)").bind(retirement.retiredAt, retirement.cleanupAfter, link.media_asset_id, link.media_asset_id)] : []),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "person.media_unlinked", "person_media", linkId, JSON.stringify({ personId: link.person_id, mediaAssetId: link.media_asset_id, assetRetirementRequested: retirement !== null }), timestamp.toISOString()),
      ...(retirement ? [context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "media.retired", "media_asset", link.media_asset_id, JSON.stringify({ reason: "last_person_media_link_retired" }), timestamp.toISOString())] : []),
    ]);
    const asset = await context.env.DB.prepare("SELECT state, cleanup_after FROM media_asset WHERE id = ?").bind(link.media_asset_id).first<{ state: "active" | "retired"; cleanup_after: string | null }>();
    return context.json({ status: "retired", mediaAssetState: asset?.state, cleanupAfter: asset?.cleanup_after ?? null });
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

  app.put("/api/admin/accounts/:accountId/scopes", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = accountScopesInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const input = parsed.data;
    const accountId = context.req.param("accountId");
    const personScopeIds = [...new Set(input.scopes.flatMap((scope) => scope.scopeType === "person" ? [scope.scopeId] : []))];
    if (personScopeIds.length > 0) {
      const people = await context.env.DB.prepare(`SELECT id FROM person WHERE id IN (${personScopeIds.map(() => "?").join(",")})`).bind(...personScopeIds).all<{ id: string }>();
      if (people.results.length !== personScopeIds.length) return context.json({ code: "scope_person_not_found" }, 404);
    }
    const branchScopeIds = [...new Set(input.scopes.flatMap((scope) => scope.scopeType === "branch" ? [scope.scopeId] : []))];
    if (branchScopeIds.length > 0) {
      const branches = await context.env.DB.prepare(`SELECT id FROM branch WHERE id IN (${branchScopeIds.map(() => "?").join(",")}) AND retired_at IS NULL`).bind(...branchScopeIds).all<{ id: string }>();
      if (branches.results.length !== branchScopeIds.length) return context.json({ code: "scope_branch_not_found" }, 404);
    }
    const timestamp = now();
    const scopeGuard = "id = ? AND status = 'active' AND version = ? AND updated_at = ?";
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE account SET version = version + 1, updated_at = ? WHERE id = ? AND status = 'active' AND version = ?").bind(timestamp, accountId, input.version),
      context.env.DB.prepare(`DELETE FROM account_scope WHERE account_id = ? AND EXISTS (SELECT 1 FROM account WHERE ${scopeGuard})`).bind(accountId, accountId, input.version + 1, timestamp),
      ...input.scopes.map((scope) => context.env.DB.prepare(
        `INSERT INTO account_scope (id, account_id, scope_type, scope_id, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account WHERE ${scopeGuard})`,
      ).bind(crypto.randomUUID(), accountId, scope.scopeType, "scopeId" in scope ? scope.scopeId : null, timestamp, accountId, input.version + 1, timestamp)),
      context.env.DB.prepare(
        `INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account WHERE ${scopeGuard})`,
      ).bind(crypto.randomUUID(), auth.accountId, "account.scope_replaced", "account", accountId, JSON.stringify({ scopes: input.scopes }), timestamp, accountId, input.version + 1, timestamp),
    ]);
    if (results[0]?.meta.changes !== 1) return context.json({ code: "account_scope_conflict", message: "账号或授权范围已变化，请刷新后重试。" }, 409);
    return context.json({ version: input.version + 1, scopes: input.scopes });
  });

  app.get("/api/admin/lineages/:lineageId/reviewer-assignments", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const assignments = await context.env.DB.prepare(
      "SELECT id, reviewer_account_id, valid_from, valid_until, reason, granted_by_account_id, created_at, revoked_at, revoked_by_account_id, revoke_reason, version FROM lineage_reviewer_assignment WHERE lineage_id = ? ORDER BY valid_from DESC, id",
    ).bind(context.req.param("lineageId")).all();
    return context.json({ assignments: assignments.results });
  });

  app.post("/api/admin/lineages/:lineageId/reviewer-assignments", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = reviewerAssignmentInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const lineageId = context.req.param("lineageId"); const input = parsed.data; const timestamp = now();
    const lineage = await context.env.DB.prepare("SELECT id FROM lineage WHERE id = ? AND retired_at IS NULL").bind(lineageId).first<{ id: string }>();
    if (!lineage) return context.json({ code: "lineage_not_found" }, 404);
    const reviewer = await context.env.DB.prepare(
      `SELECT account.id FROM account
       INNER JOIN account_role ON account_role.account_id = account.id
       INNER JOIN role ON role.id = account_role.role_id AND role.name = 'admin'
       WHERE account.id = ? AND account.status = 'active'`,
    ).bind(input.reviewerAccountId).first<{ id: string }>();
    if (!reviewer) return context.json({ code: "reviewer_not_eligible" }, 409);
    const overlap = await context.env.DB.prepare(
      "SELECT id FROM lineage_reviewer_assignment WHERE lineage_id = ? AND reviewer_account_id = ? AND revoked_at IS NULL AND valid_from < ? AND valid_until > ? LIMIT 1",
    ).bind(lineageId, input.reviewerAccountId, input.validUntil, input.validFrom).first<{ id: string }>();
    if (overlap) return context.json({ code: "reviewer_assignment_overlap" }, 409);
    const id = crypto.randomUUID();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO lineage_reviewer_assignment (id, lineage_id, reviewer_account_id, valid_from, valid_until, reason, granted_by_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, lineageId, input.reviewerAccountId, input.validFrom, input.validUntil, input.reason, auth.accountId, timestamp),
      context.env.DB.prepare("INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), auth.accountId, "lineage.reviewer_assigned", "lineage_reviewer_assignment", id, JSON.stringify({ lineageId, reviewerAccountId: input.reviewerAccountId, validFrom: input.validFrom, validUntil: input.validUntil }), timestamp),
    ]);
    return context.json({ assignment: { id, lineageId, reviewerAccountId: input.reviewerAccountId, validFrom: input.validFrom, validUntil: input.validUntil, reason: input.reason, version: 1 } }, 201);
  });

  app.post("/api/admin/reviewer-assignments/:assignmentId/revoke", requireAuthentication, async (context) => {
    const auth = context.get("auth")!;
    if (!hasPermission(auth.roles, "system.manage")) return context.json({ code: "forbidden" }, 403);
    const parsed = revokeReviewerAssignmentInput.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ code: "validation_failed", message: validationMessage(parsed) }, 400);
    const timestamp = now(); const id = context.req.param("assignmentId");
    const result = await context.env.DB.prepare("UPDATE lineage_reviewer_assignment SET revoked_at = ?, revoked_by_account_id = ?, revoke_reason = ?, version = version + 1 WHERE id = ? AND revoked_at IS NULL AND version = ?").bind(timestamp, auth.accountId, parsed.data.reason, id, parsed.data.version).run();
    if (result.meta.changes !== 1) return context.json({ code: "reviewer_assignment_conflict" }, 409);
    await writeAudit(context.env.DB, auth.accountId, "lineage.reviewer_assignment_revoked", "lineage_reviewer_assignment", id, {});
    return context.json({ status: "revoked", version: parsed.data.version + 1 });
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
