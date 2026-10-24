import { describe, expect, it } from "vitest";
import { canProposeForPeople, canProposeForPeopleWithBranchMembership, canReadVisibility, hasPermission } from "../worker/auth/authorization";

describe("authorization", () => {
  it("grants review permission to an admin", () => {
    expect(hasPermission(["admin"], "lineage.review")).toBe(true);
  });

  it("does not grant administrator permission to an editor", () => {
    expect(hasPermission(["editor"], "system.manage")).toBe(false);
  });

  it("enforces the three visibility levels", () => {
    expect(canReadVisibility(["visitor"], "PUBLIC")).toBe(true);
    expect(canReadVisibility(["visitor"], "MEMBER")).toBe(false);
    expect(canReadVisibility(["member"], "MEMBER")).toBe(true);
    expect(canReadVisibility(["editor"], "ADMIN")).toBe(false);
    expect(canReadVisibility(["admin"], "ADMIN")).toBe(true);
  });

  it("requires explicit global or person scope for an editor proposal", () => {
    expect(canProposeForPeople(["editor"], [{ scopeType: "person", scopeId: "person-a" }], ["person-a"])).toBe(true);
    expect(canProposeForPeople(["editor"], [{ scopeType: "person", scopeId: "person-a" }], ["person-a", "person-b"])).toBe(false);
    expect(canProposeForPeople(["editor"], [{ scopeType: "branch", scopeId: "branch-a" }], ["person-a"])).toBe(false);
    expect(canProposeForPeople(["editor"], [{ scopeType: "global", scopeId: null }], ["person-a", "person-b"])).toBe(true);
  });

  it("uses only exact primary-blood branch membership for branch-scoped proposals", () => {
    const scopes = [{ scopeType: "branch" as const, scopeId: "branch-a" }];
    const memberships = [
      { branchId: "branch-a", personId: "person-a", membershipKind: "blood_primary" as const },
      { branchId: "branch-a", personId: "person-b", membershipKind: "migration" as const },
      { branchId: "branch-child", personId: "person-c", membershipKind: "blood_primary" as const },
    ];
    expect(canProposeForPeopleWithBranchMembership(["editor"], scopes, ["person-a"], memberships)).toBe(true);
    expect(canProposeForPeopleWithBranchMembership(["editor"], scopes, ["person-a", "person-b"], memberships)).toBe(false);
    expect(canProposeForPeopleWithBranchMembership(["editor"], scopes, ["person-c"], memberships)).toBe(false);
  });
});
