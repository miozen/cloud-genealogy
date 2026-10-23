import type { HistoricalLineageProjection } from "./historical-lineage-projection";

export interface HistoricalLineageComparison {
  canonicalEdges: Array<{ parentPersonId: string; childPersonId: string; status: "same" | "canonical_only" }>;
  historicalEdges: Array<{ claimId: string; parentRecordId: string; childRecordId: string; parentKind: string; status: "same" | "historical_only" | "uncomparable" }>;
}

/** Compares only explicit source-to-person mappings; absence is never inferred. */
export function compareHistoricalLineage(
  canonicalEdges: readonly { parentPersonId: string; childPersonId: string }[],
  historical: HistoricalLineageProjection,
): HistoricalLineageComparison {
  const personByRecord = new Map(historical.nodes.map((node) => [node.sourceRecordId, node.confirmedPersonId]));
  const canonicalKeys = new Set(canonicalEdges.map((edge) => `${edge.parentPersonId}\u0000${edge.childPersonId}`));
  const matchedKeys = new Set<string>();
  const projectedHistorical = historical.parentChildEdges.map((edge) => {
    const parentPersonId = personByRecord.get(edge.parentRecordId);
    const childPersonId = personByRecord.get(edge.childRecordId);
    if (!parentPersonId || !childPersonId) {
      return { claimId: edge.claimId, parentRecordId: edge.parentRecordId, childRecordId: edge.childRecordId, parentKind: edge.parentKind, status: "uncomparable" as const };
    }
    const key = `${parentPersonId}\u0000${childPersonId}`;
    const status = canonicalKeys.has(key) ? "same" as const : "historical_only" as const;
    if (status === "same") matchedKeys.add(key);
    return { claimId: edge.claimId, parentRecordId: edge.parentRecordId, childRecordId: edge.childRecordId, parentKind: edge.parentKind, status };
  });
  return {
    canonicalEdges: canonicalEdges.map((edge) => ({ ...edge, status: matchedKeys.has(`${edge.parentPersonId}\u0000${edge.childPersonId}`) ? "same" as const : "canonical_only" as const })),
    historicalEdges: projectedHistorical,
  };
}
