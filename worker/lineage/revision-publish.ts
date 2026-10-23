import type { SuccessionEdgeCandidate } from "./succession-validation";
import { previewSuccessionRevision } from "./revision-preview";

export interface PublishRevisionInput {
  lineageId: string;
  revisionId: string;
  basedOnRevisionId?: string;
  baseEdges: readonly SuccessionEdgeCandidate[];
  proposedEdges: readonly SuccessionEdgeCandidate[];
  now: string;
}

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

  const statements = [
    database.prepare(
      "INSERT INTO lineage_revision (id, lineage_id, state, based_on_revision_id, created_at, published_at) VALUES (?, ?, 'published', ?, ?, ?)",
    ).bind(input.revisionId, input.lineageId, input.basedOnRevisionId ?? null, input.now, input.now),
    ...input.proposedEdges.map((edge, index) =>
      database.prepare(
        "INSERT INTO lineage_succession_snapshot (id, revision_id, parent_person_id, child_person_id, order_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(`${input.revisionId}:succession:${index}`, input.revisionId, edge.parentPersonId, edge.childPersonId, String(index).padStart(8, "0"), input.now),
    ),
    database.prepare(
      "INSERT INTO lineage_published_pointer (lineage_id, revision_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(lineage_id) DO UPDATE SET revision_id = excluded.revision_id, updated_at = excluded.updated_at",
    ).bind(input.lineageId, input.revisionId, input.now),
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

export interface RollbackRevisionInput {
  lineageId: string;
  targetRevisionId: string;
  newRevisionId: string;
  now: string;
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
    now: input.now,
  });
}
