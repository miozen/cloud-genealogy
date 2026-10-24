import { previewSuccessionRevision } from "./revision-preview";
import type { CanonicalRelationCandidate } from "./revision-publish";
import type { SuccessionEdgeCandidate } from "./succession-validation";

export type ChangeItemCandidate =
  | { operation: "succession_add" | "succession_remove"; subjectPersonId: string; relatedPersonId: string }
  | { operation: "relation_add" | "relation_remove"; subjectPersonId: string; relatedPersonId: string; relationKind: CanonicalRelationCandidate["relationKind"] };

export function previewChangeRequest(baseEdges: readonly SuccessionEdgeCandidate[], baseRelations: readonly CanonicalRelationCandidate[], items: readonly ChangeItemCandidate[]) {
  const edges = new Map(baseEdges.map((edge) => [edgeKey(edge.parentPersonId, edge.childPersonId), edge]));
  const relations = new Map(baseRelations.map((relation) => [relationKey(relation), relation]));
  for (const item of items) {
    if (item.operation === "succession_add") edges.set(edgeKey(item.subjectPersonId, item.relatedPersonId), { parentPersonId: item.subjectPersonId, childPersonId: item.relatedPersonId });
    if (item.operation === "succession_remove") edges.delete(edgeKey(item.subjectPersonId, item.relatedPersonId));
    if (item.operation === "relation_add") relations.set(relationKey(item), { subjectPersonId: item.subjectPersonId, relatedPersonId: item.relatedPersonId, relationKind: item.relationKind });
    if (item.operation === "relation_remove") relations.delete(relationKey(item));
  }
  const succession = previewSuccessionRevision({ baseEdges, proposedEdges: [...edges.values()] });
  return { ...succession, edges: [...edges.values()], relations: [...relations.values()] };
}

function edgeKey(parentPersonId: string, childPersonId: string) { return `${parentPersonId}\u0000${childPersonId}`; }
function relationKey(relation: CanonicalRelationCandidate) { return `${relation.subjectPersonId}\u0000${relation.relatedPersonId}\u0000${relation.relationKind}`; }
