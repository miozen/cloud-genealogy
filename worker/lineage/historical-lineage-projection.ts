export type HistoricalGraphKind = "parent_to_child" | "child_to_parent" | "spouse" | "non_graph";
export type HistoricalParentKind = "biological_parent" | "adoptive_parent" | "successor_parent";

export interface HistoricalSourceRecord {
  id: string;
  displayName: string | null;
  confirmedPersonId: string | null;
}

export interface HistoricalRelationClaim {
  id: string;
  subjectRecordId: string;
  relatedRecordId: string | null;
  relationKind: string;
  rawText: string;
}

export interface HistoricalRelationSemanticRule {
  relationKind: string;
  graphKind: HistoricalGraphKind;
  parentKind: HistoricalParentKind | null;
}

export interface HistoricalLineageProjection {
  nodes: Array<{ sourceRecordId: string; displayName: string | null; confirmedPersonId: string | null }>;
  parentChildEdges: Array<{ claimId: string; parentRecordId: string; childRecordId: string; parentKind: HistoricalParentKind; rawText: string }>;
  spouseEdges: Array<{ claimId: string; leftRecordId: string; rightRecordId: string; rawText: string }>;
  annotations: Array<{ claimId: string; status: "pending_interpretation" | "not_graphable" | "incomplete"; relationKind: string; rawText: string }>;
}

/**
 * Converts only explicitly configured source semantics into graph edges. It is
 * deliberately independent of D1 and canonical lineage data: source claims
 * stay source claims and unknown relation words remain pending.
 */
export function projectHistoricalLineage(
  records: readonly HistoricalSourceRecord[],
  claims: readonly HistoricalRelationClaim[],
  rules: readonly HistoricalRelationSemanticRule[],
): HistoricalLineageProjection {
  const recordIds = new Set(records.map((record) => record.id));
  const ruleByKind = new Map(rules.map((rule) => [rule.relationKind, rule]));
  const parentChildEdges: HistoricalLineageProjection["parentChildEdges"] = [];
  const spouseEdges: HistoricalLineageProjection["spouseEdges"] = [];
  const annotations: HistoricalLineageProjection["annotations"] = [];

  for (const claim of claims) {
    const rule = ruleByKind.get(claim.relationKind);
    if (!rule) {
      annotations.push({ claimId: claim.id, status: "pending_interpretation", relationKind: claim.relationKind, rawText: claim.rawText });
      continue;
    }
    if (rule.graphKind === "non_graph") {
      annotations.push({ claimId: claim.id, status: "not_graphable", relationKind: claim.relationKind, rawText: claim.rawText });
      continue;
    }
    if (!claim.relatedRecordId || !recordIds.has(claim.subjectRecordId) || !recordIds.has(claim.relatedRecordId)) {
      annotations.push({ claimId: claim.id, status: "incomplete", relationKind: claim.relationKind, rawText: claim.rawText });
      continue;
    }
    if (rule.graphKind === "spouse") {
      spouseEdges.push({ claimId: claim.id, leftRecordId: claim.subjectRecordId, rightRecordId: claim.relatedRecordId, rawText: claim.rawText });
      continue;
    }
    const parentRecordId = rule.graphKind === "parent_to_child" ? claim.subjectRecordId : claim.relatedRecordId;
    const childRecordId = rule.graphKind === "parent_to_child" ? claim.relatedRecordId : claim.subjectRecordId;
    parentChildEdges.push({ claimId: claim.id, parentRecordId, childRecordId, parentKind: rule.parentKind!, rawText: claim.rawText });
  }

  return {
    nodes: [...records].map((record) => ({ sourceRecordId: record.id, displayName: record.displayName, confirmedPersonId: record.confirmedPersonId })),
    parentChildEdges,
    spouseEdges,
    annotations,
  };
}
