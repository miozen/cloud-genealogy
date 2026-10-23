import {
  type SuccessionEdgeCandidate,
  type SuccessionValidationIssue,
  validateSuccessionEdges,
} from "./succession-validation";

export interface RevisionPreviewInput {
  baseEdges: readonly SuccessionEdgeCandidate[];
  proposedEdges: readonly SuccessionEdgeCandidate[];
}

export interface RevisionPreview {
  valid: boolean;
  issues: SuccessionValidationIssue[];
  affectedChildPersonIds: string[];
  addedEdgeCount: number;
  removedEdgeCount: number;
}

/**
 * Shared preflight contract for a future draft-preview endpoint and publish
 * transaction. It does not persist a revision or mutate the source layer.
 */
export function previewSuccessionRevision(input: RevisionPreviewInput): RevisionPreview {
  const issues = validateSuccessionEdges(input.proposedEdges);
  const base = edgeKeys(input.baseEdges);
  const proposed = edgeKeys(input.proposedEdges);
  const changedChildren = new Set<string>();

  for (const edge of input.baseEdges) {
    if (!proposed.has(edgeKey(edge))) changedChildren.add(edge.childPersonId);
  }
  for (const edge of input.proposedEdges) {
    if (!base.has(edgeKey(edge))) changedChildren.add(edge.childPersonId);
  }

  return {
    valid: issues.length === 0,
    issues,
    affectedChildPersonIds: [...changedChildren].sort(),
    addedEdgeCount: [...proposed].filter((key) => !base.has(key)).length,
    removedEdgeCount: [...base].filter((key) => !proposed.has(key)).length,
  };
}

function edgeKeys(edges: readonly SuccessionEdgeCandidate[]): Set<string> {
  return new Set(edges.map(edgeKey));
}

function edgeKey(edge: SuccessionEdgeCandidate): string {
  return edge.parentPersonId + "\u0000" + edge.childPersonId;
}
