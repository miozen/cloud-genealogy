import { expect, it } from "vitest";
import { canSubmitBranchChange, previewRetirements, projectComposerBranches, retirementsAreConfirmed, type WorkbenchBranch } from "../src/branch-workbench-composer";

const base: WorkbenchBranch[] = [
  { branchId: "root", parentBranchId: null, name: "长房", branchKind: "agnatic", retiredAt: null, membershipCount: 2, accountScopeCount: 0 },
  { branchId: "child", parentBranchId: "root", name: "二支", branchKind: "agnatic", retiredAt: null, membershipCount: 1, accountScopeCount: 0 },
];

it("projects local composition without mutating the published branch model", () => {
  const result = projectComposerBranches(base, [
    { operation: "rename", branchId: "child", parentBranchId: null, name: "次房", branchKind: "agnatic" },
    { operation: "create", branchId: "new", parentBranchId: "root", name: "三支", branchKind: "migration" },
    { operation: "retire", branchId: "child", parentBranchId: null, name: "", branchKind: "agnatic" },
  ]);
  expect(result.find((branch) => branch.branchId === "child")).toMatchObject({ name: "次房", retiredAt: "__PROPOSED_RETIREMENT__" });
  expect(result.find((branch) => branch.branchId === "new")).toMatchObject({ parentBranchId: "root", membershipCount: 0 });
  expect(base.find((branch) => branch.branchId === "child")).toMatchObject({ name: "二支", retiredAt: null });
});

it("requires exact retirement-name confirmation only when a preview retires a branch", () => {
  const retirements = previewRetirements([{ branchId: "child", name: "二支", retiredAt: "__PROPOSED_RETIREMENT__" }]);
  expect(retirementsAreConfirmed(retirements, {})).toBe(false);
  expect(retirementsAreConfirmed(retirements, { child: "二 房" })).toBe(false);
  expect(retirementsAreConfirmed(retirements, { child: " 二支 " })).toBe(true);
  expect(retirementsAreConfirmed([], {})).toBe(true);
});

it("blocks submission for invalid previews or unconfirmed retirements", () => {
  const retirements = [{ branchId: "child", name: "二支", retiredAt: "__PROPOSED_RETIREMENT__" }];
  expect(canSubmitBranchChange(false, retirements, { child: "二支" })).toBe(false);
  expect(canSubmitBranchChange(true, retirements, { child: "错误房名" })).toBe(false);
  expect(canSubmitBranchChange(true, retirements, { child: "二支" })).toBe(true);
  expect(canSubmitBranchChange(true, [], {})).toBe(true);
});
