import type { SuccessionEdgeCandidate } from "./succession-validation";
import { previewSuccessionRevision } from "./revision-preview";

export interface RevisionAuditEntry {
  id: string;
  actorAccountId: string;
  action: string;
  objectType: string;
  objectId: string;
  metadataJson: string;
}

export interface PublishRevisionInput {
  lineageId: string;
  revisionId: string;
  basedOnRevisionId?: string;
  baseEdges: readonly SuccessionEdgeCandidate[];
  proposedEdges: readonly SuccessionEdgeCandidate[];
  proposedRelations?: readonly CanonicalRelationCandidate[];
  proposedBranchMemberships?: readonly BranchMembershipSnapshotRow[];
  proposedBranchStructures?: readonly BranchStructureSnapshotRow[];
  branchStructureMutations?: readonly BranchStructureMutation[];
  expectedPointerVersion: number;
  now: string;
  audit: RevisionAuditEntry;
  changeRequest?: { id: string; version: number };
}
export interface CanonicalRelationCandidate { subjectPersonId: string; relatedPersonId: string; relationKind: "biological_parent" | "adoptive_parent" | "successor_parent" | "spouse"; }
export interface BranchMembershipSnapshotRow { branch_id: string; person_id: string; membership_kind: "blood_primary" | "migration" | "administrative"; }
export interface BranchStructureSnapshotRow { branch_id: string; parent_branch_id: string | null; name: string; branch_kind: "agnatic" | "migration" | "administrative"; retired_at: string | null; }
export type BranchStructureMutation =
  | { operation: "create"; branchId: string; parentBranchId: string | null; name: string; branchKind: BranchStructureSnapshotRow["branch_kind"] }
  | { operation: "rename"; branchId: string; name: string }
  | { operation: "retire"; branchId: string };

export type PublishRevisionResult =
  | { published: true; revisionId: string }
  | { published: false; issues: ReturnType<typeof previewSuccessionRevision>["issues"] };

/** Writes a complete immutable snapshot and switches only the lineage pointer. */
export async function publishSuccessionRevision(
  database: D1Database,
  input: PublishRevisionInput,
): Promise<PublishRevisionResult> {
  const preview = previewSuccessionRevision(input);
  if (!preview.valid) return { published: false, issues: preview.issues };

  const lineage = await database.prepare("SELECT id FROM lineage WHERE id = ?").bind(input.lineageId).first<{ id: string }>();
  if (!lineage) throw new Error("Lineage does not exist.");
  // Branch membership is an independent administrative snapshot. A relation
  // proposal does not infer it, so a new revision carries its base snapshot
  // forward unchanged.
  const branchMemberships = input.proposedBranchMemberships
    ? { results: input.proposedBranchMemberships }
    : input.basedOnRevisionId
    ? await database.prepare("SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = ? ORDER BY branch_id, membership_kind, person_id, id").bind(input.basedOnRevisionId).all<BranchMembershipSnapshotRow>()
    : { results: [] as BranchMembershipSnapshotRow[] };
  // A structural snapshot is copied with every revision.  The fallback for an
  // empty legacy base is only for local/bootstrap histories created before
  // structure snapshots existed; later structural proposals supply it exactly.
  let branchStructures = input.proposedBranchStructures
    ? { results: input.proposedBranchStructures }
    : input.basedOnRevisionId
    ? await database.prepare("SELECT branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch_structure_snapshot WHERE revision_id = ? ORDER BY parent_branch_id, name, branch_id").bind(input.basedOnRevisionId).all<BranchStructureSnapshotRow>()
    : await database.prepare("SELECT id AS branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch WHERE lineage_id = ? ORDER BY parent_branch_id, name, id").bind(input.lineageId).all<BranchStructureSnapshotRow>();
  if (input.basedOnRevisionId && branchStructures.results.length === 0 && !input.proposedBranchStructures) {
    branchStructures = await database.prepare("SELECT id AS branch_id, parent_branch_id, name, branch_kind, retired_at FROM branch WHERE lineage_id = ? ORDER BY parent_branch_id, name, id").bind(input.lineageId).all<BranchStructureSnapshotRow>();
  }

  const statements = [
    database.prepare(
      "INSERT INTO lineage_revision (id, lineage_id, state, based_on_revision_id, expected_pointer_version, change_request_id, change_request_version, created_at, published_at) VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?)",
    ).bind(input.revisionId, input.lineageId, input.basedOnRevisionId ?? null, input.expectedPointerVersion, input.changeRequest?.id ?? null, input.changeRequest?.version ?? null, input.now, input.now),
    ...(input.branchStructureMutations ?? []).map((item) => item.operation === "create"
      ? database.prepare("INSERT INTO branch (id, lineage_id, parent_branch_id, name, branch_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(item.branchId, input.lineageId, item.parentBranchId, item.name, item.branchKind, input.now)
      : item.operation === "rename"
      ? database.prepare("UPDATE branch SET name = ? WHERE id = ? AND lineage_id = ? AND retired_at IS NULL").bind(item.name, item.branchId, input.lineageId)
      : database.prepare("UPDATE branch SET retired_at = ? WHERE id = ? AND lineage_id = ? AND retired_at IS NULL").bind(input.now, item.branchId, input.lineageId),
    ),
    ...input.proposedEdges.map((edge, index) =>
      database.prepare(
        "INSERT INTO lineage_succession_snapshot (id, revision_id, parent_person_id, child_person_id, order_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(`${input.revisionId}:succession:${index}`, input.revisionId, edge.parentPersonId, edge.childPersonId, String(index).padStart(8, "0"), input.now),
    ),
    ...(input.proposedRelations ?? []).map((relation, index) =>
      database.prepare("INSERT INTO canonical_relation_snapshot (id, revision_id, subject_person_id, related_person_id, relation_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(`${input.revisionId}:relation:${index}`, input.revisionId, relation.subjectPersonId, relation.relatedPersonId, relation.relationKind, input.now),
    ),
    ...branchMemberships.results.map((membership, index) =>
      database.prepare("INSERT INTO branch_membership_snapshot (id, revision_id, branch_id, person_id, membership_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(`${input.revisionId}:branch:${index}`, input.revisionId, membership.branch_id, membership.person_id, membership.membership_kind, input.now),
    ),
    ...branchStructures.results.map((branch, index) =>
      database.prepare("INSERT INTO branch_structure_snapshot (id, revision_id, branch_id, parent_branch_id, name, branch_kind, retired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(`${input.revisionId}:branch-structure:${index}`, input.revisionId, branch.branch_id, branch.parent_branch_id, branch.name, branch.branch_kind, branch.retired_at, input.now),
    ),
    database.prepare(
      "INSERT INTO lineage_published_pointer (lineage_id, revision_id, updated_at, version) VALUES (?, ?, ?, 1) ON CONFLICT(lineage_id) DO UPDATE SET revision_id = excluded.revision_id, updated_at = excluded.updated_at, version = lineage_published_pointer.version + 1 WHERE lineage_published_pointer.version = ?",
    ).bind(input.lineageId, input.revisionId, input.now, input.expectedPointerVersion),
    ...(input.changeRequest ? [
      database.prepare("UPDATE change_request SET state = 'published', published_at = ?, version = version + 1 WHERE id = ? AND state = 'approved' AND version = ?")
        .bind(input.now, input.changeRequest.id, input.changeRequest.version),
    ] : []),
    ...[
      database.prepare(
        "INSERT INTO audit_log (id, actor_account_id, action, object_type, object_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        input.audit.id,
        input.audit.actorAccountId,
        input.audit.action,
        input.audit.objectType,
        input.audit.objectId,
        input.audit.metadataJson,
        input.now,
      ),
    ],
  ];
  await database.batch(statements);
  return { published: true, revisionId: input.revisionId };
}

export async function buildRollbackEdges(database: D1Database, revisionId: string): Promise<SuccessionEdgeCandidate[]> {
  const rows = await database.prepare(
    "SELECT parent_person_id, child_person_id FROM lineage_succession_snapshot WHERE revision_id = ? ORDER BY order_key",
  ).bind(revisionId).all<{ parent_person_id: string; child_person_id: string }>();
  return rows.results.map((row) => ({ parentPersonId: row.parent_person_id, childPersonId: row.child_person_id }));
}
export async function buildRollbackRelations(database: D1Database, revisionId: string): Promise<CanonicalRelationCandidate[]> {
  const rows = await database.prepare("SELECT subject_person_id, related_person_id, relation_kind FROM canonical_relation_snapshot WHERE revision_id = ? ORDER BY id").bind(revisionId).all<{ subject_person_id: string; related_person_id: string; relation_kind: CanonicalRelationCandidate["relationKind"] }>();
  return rows.results.map((row) => ({ subjectPersonId: row.subject_person_id, relatedPersonId: row.related_person_id, relationKind: row.relation_kind }));
}

export interface RollbackRevisionInput {
  lineageId: string;
  targetRevisionId: string;
  newRevisionId: string;
  expectedPointerVersion: number;
  now: string;
  audit: RevisionAuditEntry;
}

/** Rollback republishes a historical snapshot as a new immutable revision. */
export async function rollbackSuccessionRevision(
  database: D1Database,
  input: RollbackRevisionInput,
): Promise<PublishRevisionResult> {
  const current = await database.prepare(
    "SELECT revision_id FROM lineage_published_pointer WHERE lineage_id = ?",
  ).bind(input.lineageId).first<{ revision_id: string }>();
  if (!current) throw new Error("Lineage has no published revision.");

  const target = await database.prepare(
    "SELECT id FROM lineage_revision WHERE id = ? AND lineage_id = ? AND state = 'published'",
  ).bind(input.targetRevisionId, input.lineageId).first<{ id: string }>();
  if (!target) throw new Error("Rollback target is not a published revision of this lineage.");

  return publishSuccessionRevision(database, {
    lineageId: input.lineageId,
    revisionId: input.newRevisionId,
    basedOnRevisionId: input.targetRevisionId,
    baseEdges: await buildRollbackEdges(database, current.revision_id),
    proposedEdges: await buildRollbackEdges(database, input.targetRevisionId),
    proposedRelations: await buildRollbackRelations(database, input.targetRevisionId),
    expectedPointerVersion: input.expectedPointerVersion,
    now: input.now,
    audit: input.audit,
  });
}
