import { describe, expect, it } from "vitest";
import { hasPermission } from "../worker/auth/authorization";

describe("authorization", () => {
  it("grants review permission to a reviewer", () => {
    expect(hasPermission(["reviewer"], "lineage.review")).toBe(true);
  });

  it("does not grant administrator permission to a branch editor", () => {
    expect(hasPermission(["branch_editor"], "system.manage")).toBe(false);
  });
});
