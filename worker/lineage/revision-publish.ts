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
