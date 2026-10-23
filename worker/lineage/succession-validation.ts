export interface SuccessionEdgeCandidate {
  parentPersonId: string;
  childPersonId: string;
}

export type SuccessionValidationCode = "self_parent" | "multiple_succession_parents" | "succession_cycle";

export interface SuccessionValidationIssue {
  code: SuccessionValidationCode;
  personIds: string[];
}

/** Pure validation shared by draft preview and revision publishing. */
export function validateSuccessionEdges(edges: readonly SuccessionEdgeCandidate[]): SuccessionValidationIssue[] {
  const issues: SuccessionValidationIssue[] = [];
  const parentByChild = new Map<string, string>();

  for (const edge of edges) {
    if (edge.parentPersonId === edge.childPersonId) {
      issues.push({ code: "self_parent", personIds: [edge.childPersonId] });
      continue;
    }
    const existingParent = parentByChild.get(edge.childPersonId);
    if (existingParent && existingParent !== edge.parentPersonId) {
      issues.push({ code: "multiple_succession_parents", personIds: [edge.childPersonId, existingParent, edge.parentPersonId] });
      continue;
    }
    parentByChild.set(edge.childPersonId, edge.parentPersonId);
  }

  for (const child of parentByChild.keys()) {
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let current: string | undefined = child;
    while (current) {
      const previousIndex = seenAt.get(current);
      if (previousIndex !== undefined) {
        issues.push({ code: "succession_cycle", personIds: path.slice(previousIndex) });
        break;
      }
      seenAt.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issue.code + ":" + [...issue.personIds].sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
