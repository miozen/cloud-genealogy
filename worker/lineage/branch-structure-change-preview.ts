export type BranchKind = "agnatic" | "migration" | "administrative";
export type BranchStructureCandidate = { branchId: string; parentBranchId: string | null; name: string; branchKind: BranchKind; retiredAt: string | null };
export type BranchStructureChangeItemCandidate =
  | { operation: "create"; branchId: string; parentBranchId: string | null; name: string; branchKind: BranchKind }
  | { operation: "rename"; branchId: string; name: string }
  | { operation: "retire"; branchId: string };
export type BranchStructureIssue = { code: "branch_exists" | "branch_not_active" | "parent_not_active" | "duplicate_sibling_name" | "branch_has_active_child"; branchIds: string[] };

/** Pure proposal projection; callers supply membership/scope retirement checks. */
export function previewBranchStructureChange(base: readonly BranchStructureCandidate[], items: readonly BranchStructureChangeItemCandidate[]) {
  const branches = new Map(base.map((branch) => [branch.branchId, { ...branch }]));
  const issues: BranchStructureIssue[] = [];
  for (const item of items) {
    if (item.operation === "create") {
      if (branches.has(item.branchId)) { issues.push({ code: "branch_exists", branchIds: [item.branchId] }); continue; }
      if (item.parentBranchId && branches.get(item.parentBranchId)?.retiredAt !== null) { issues.push({ code: "parent_not_active", branchIds: [item.parentBranchId] }); continue; }
      branches.set(item.branchId, { branchId: item.branchId, parentBranchId: item.parentBranchId, name: item.name, branchKind: item.branchKind, retiredAt: null });
    } else {
      const branch = branches.get(item.branchId);
      if (!branch || branch.retiredAt !== null) { issues.push({ code: "branch_not_active", branchIds: [item.branchId] }); continue; }
      if (item.operation === "rename") branch.name = item.name;
      else {
        const child = [...branches.values()].find((candidate) => candidate.parentBranchId === item.branchId && candidate.retiredAt === null);
        if (child) { issues.push({ code: "branch_has_active_child", branchIds: [item.branchId, child.branchId] }); continue; }
        branch.retiredAt = "__PROPOSED_RETIREMENT__";
      }
    }
  }
  const siblingNames = new Map<string, string>();
  for (const branch of branches.values()) {
    if (branch.retiredAt !== null) continue;
    const key = `${branch.parentBranchId ?? ""}\u0000${branch.name}`;
    const existing = siblingNames.get(key);
    if (existing && existing !== branch.branchId) issues.push({ code: "duplicate_sibling_name", branchIds: [existing, branch.branchId] });
    siblingNames.set(key, branch.branchId);
  }
  return { valid: issues.length === 0, issues, branches: [...branches.values()] };
}
