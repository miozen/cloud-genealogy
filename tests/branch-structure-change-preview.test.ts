import { expect, it } from "vitest";
import { previewBranchStructureChange } from "../worker/lineage/branch-structure-change-preview";

const base = [
  { branchId: "root", parentBranchId: null, name: "长房", branchKind: "agnatic" as const, retiredAt: null },
  { branchId: "child", parentBranchId: "root", name: "二支", branchKind: "agnatic" as const, retiredAt: null },
];

it("projects create and rename without mutating the base", () => {
  const result = previewBranchStructureChange(base, [
    { operation: "create", branchId: "new", parentBranchId: "root", name: "三支", branchKind: "agnatic" },
    { operation: "rename", branchId: "child", name: "次房" },
  ]);
  expect(result.valid).toBe(true);
  expect(result.branches.find((branch) => branch.branchId === "child")?.name).toBe("次房");
  expect(base[1]?.name).toBe("二支");
});

it("rejects duplicate sibling names and retirement with active children", () => {
  const result = previewBranchStructureChange(base, [
    { operation: "create", branchId: "same", parentBranchId: "root", name: "二支", branchKind: "agnatic" },
    { operation: "retire", branchId: "root" },
  ]);
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain("duplicate_sibling_name");
  expect(result.issues.map((issue) => issue.code)).toContain("branch_has_active_child");
});
