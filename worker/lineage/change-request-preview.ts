import { previewSuccessionRevision } from "./revision-preview";
import type { CanonicalRelationCandidate } from "./revision-publish";
import type { SuccessionEdgeCandidate } from "./succession-validation";

export type ChangeItemCandidate =
  | { operation: "succession_add" | "succession_remove"; subjectPersonId: string; relatedPersonId: string }
  | { operation: "relation_add" | "relation_remove"; subjectPersonId: string; relatedPersonId: string; relationKind: CanonicalRelationCandidate["relationKind"] };
export type BranchMembershipCandidate = { branchId: string; personId: string; membershipKind: "blood_primary" | "migration" | "administrative" };
export type BranchMembershipChangeItemCandidate = { operation: "add" | "remove"; branchId: string; personId: string; membershipKind: BranchMembershipCandidate["membershipKind"] };

export function previewChangeRequest(baseEdges: readonly SuccessionEdgeCandidate[], baseRelations: readonly CanonicalRelationCandidate[], items: readonly ChangeItemCandidate[], baseMemberships: readonly BranchMembershipCandidate[] = [], membershipItems: readonly BranchMembershipChangeItemCandidate[] = []) {
  const edges = new Map(baseEdges.map((edge) => [edgeKey(edge.parentPersonId, edge.childPersonId), edge]));
  const relations = new Map(baseRelations.map((relation) => [relationKey(relation), relation]));
  for (const item of items) {
    if (item.operation === "succession_add") edges.set(edgeKey(item.subjectPersonId, item.relatedPersonId), { parentPersonId: item.subjectPersonId, childPersonId: item.relatedPersonId });
    if (item.operation === "succession_remove") edges.delete(edgeKey(item.subjectPersonId, item.relatedPersonId));
    if (item.operation === "relation_add") relations.set(relationKey(item), { subjectPersonId: item.subjectPersonId, relatedPersonId: item.relatedPersonId, relationKind: item.relationKind });
    if (item.operation === "relation_remove") relations.delete(relationKey(item));
  }
  const memberships = new Map(baseMemberships.map((membership) => [membershipKey(membership), membership]));
  const membershipIssues: Array<{ code: "membership_already_exists" | "membership_not_found" | "multiple_primary_branch"; personIds: string[] }> = [];
  for (const item of membershipItems) {
    const membership = { branchId: item.branchId, personId: item.personId, membershipKind: item.membershipKind };
    if (item.operation === "add") {
      if (memberships.has(membershipKey(membership))) membershipIssues.push({ code: "membership_already_exists", personIds: [item.personId] });
      else memberships.set(membershipKey(membership), membership);
    } else if (!memberships.delete(membershipKey(membership))) membershipIssues.push({ code: "membership_not_found", personIds: [item.personId] });
  }
  const succession = previewSuccessionRevision({ baseEdges, proposedEdges: [...edges.values()] });
  const primaryPeople = new Set<string>();
  for (const membership of memberships.values()) {
    if (membership.membershipKind === "blood_primary" && primaryPeople.has(membership.personId)) membershipIssues.push({ code: "multiple_primary_branch", personIds: [membership.personId] });
    if (membership.membershipKind === "blood_primary") primaryPeople.add(membership.personId);
  }
  return { ...succession, valid: succession.valid && membershipIssues.length === 0, issues: [...succession.issues, ...membershipIssues], edges: [...edges.values()], relations: [...relations.values()], memberships: [...memberships.values()] };
}

/** Produces an explicit proposal that changes one published snapshot into another. */
export function buildSnapshotChangeItems(baseEdges: readonly SuccessionEdgeCandidate[], baseRelations: readonly CanonicalRelationCandidate[], targetEdges: readonly SuccessionEdgeCandidate[], targetRelations: readonly CanonicalRelationCandidate[]): ChangeItemCandidate[] {
  const baseEdgeKeys = new Set(baseEdges.map((edge) => edgeKey(edge.parentPersonId, edge.childPersonId)));
  const targetEdgeKeys = new Set(targetEdges.map((edge) => edgeKey(edge.parentPersonId, edge.childPersonId)));
  const baseRelationKeys = new Set(baseRelations.map(relationKey));
  const targetRelationKeys = new Set(targetRelations.map(relationKey));
  return [
    ...baseEdges.filter((edge) => !targetEdgeKeys.has(edgeKey(edge.parentPersonId, edge.childPersonId))).map((edge) => ({ operation: "succession_remove" as const, subjectPersonId: edge.parentPersonId, relatedPersonId: edge.childPersonId })),
    ...targetEdges.filter((edge) => !baseEdgeKeys.has(edgeKey(edge.parentPersonId, edge.childPersonId))).map((edge) => ({ operation: "succession_add" as const, subjectPersonId: edge.parentPersonId, relatedPersonId: edge.childPersonId })),
    ...baseRelations.filter((relation) => !targetRelationKeys.has(relationKey(relation))).map((relation) => ({ operation: "relation_remove" as const, ...relation })),
    ...targetRelations.filter((relation) => !baseRelationKeys.has(relationKey(relation))).map((relation) => ({ operation: "relation_add" as const, ...relation })),
  ];
}

/** Produces explicit membership proposal items for rollback or comparison. */
export function buildSnapshotMembershipChangeItems(baseMemberships: readonly BranchMembershipCandidate[], targetMemberships: readonly BranchMembershipCandidate[]): BranchMembershipChangeItemCandidate[] {
  const base = new Map(baseMemberships.map((membership) => [membershipKey(membership), membership]));
  const target = new Map(targetMemberships.map((membership) => [membershipKey(membership), membership]));
  return [
    ...baseMemberships.filter((membership) => !target.has(membershipKey(membership))).map((membership) => ({ operation: "remove" as const, ...membership })),
    ...targetMemberships.filter((membership) => !base.has(membershipKey(membership))).map((membership) => ({ operation: "add" as const, ...membership })),
  ];
}

function edgeKey(parentPersonId: string, childPersonId: string) { return `${parentPersonId}\u0000${childPersonId}`; }
function relationKey(relation: CanonicalRelationCandidate) { return `${relation.subjectPersonId}\u0000${relation.relatedPersonId}\u0000${relation.relationKind}`; }
function membershipKey(membership: BranchMembershipCandidate) { return `${membership.branchId}\u0000${membership.personId}\u0000${membership.membershipKind}`; }
