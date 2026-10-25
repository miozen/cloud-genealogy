export type BranchKind = "agnatic" | "migration" | "administrative";
export type WorkbenchBranch = { branchId: string; parentBranchId: string | null; name: string; branchKind: BranchKind; retiredAt: string | null; membershipCount: number; accountScopeCount: number };
export type LocalStructureItem = { operation: "create" | "rename" | "retire"; branchId: string; parentBranchId: string | null; name: string; branchKind: BranchKind };
export type RetirementCandidate = { branchId: string; name: string; retiredAt: string | null };

/** Applies only browser-local structure items; it never performs network I/O or mutates the published model. */
export function projectComposerBranches(base: readonly WorkbenchBranch[], items: readonly LocalStructureItem[]): WorkbenchBranch[] {
  const branches = new Map(base.map((branch) => [branch.branchId, { ...branch }]));
  for (const item of items) {
    if (item.operation === "create") branches.set(item.branchId, { branchId: item.branchId, parentBranchId: item.parentBranchId, name: item.name, branchKind: item.branchKind, retiredAt: null, membershipCount: 0, accountScopeCount: 0 });
    if (item.operation === "rename" && branches.has(item.branchId)) branches.get(item.branchId)!.name = item.name;
    if (item.operation === "retire" && branches.has(item.branchId)) branches.get(item.branchId)!.retiredAt = "__PROPOSED_RETIREMENT__";
  }
  return [...branches.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function previewRetirements(branches: readonly RetirementCandidate[]): RetirementCandidate[] {
  return branches.filter((branch) => branch.retiredAt === "__PROPOSED_RETIREMENT__");
}

export function retirementsAreConfirmed(retirements: readonly RetirementCandidate[], confirmations: Readonly<Record<string, string>>): boolean {
  return retirements.every((branch) => confirmations[branch.branchId]?.trim() === branch.name);
}

export function canSubmitBranchChange(previewValid: boolean, retirements: readonly RetirementCandidate[], confirmations: Readonly<Record<string, string>>): boolean {
  return previewValid && retirementsAreConfirmed(retirements, confirmations);
}
