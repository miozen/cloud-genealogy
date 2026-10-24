import type { PermissionName, RoleName } from "../types";

export type Visibility = "PUBLIC" | "MEMBER" | "ADMIN";
export type AccountScope = { scopeType: "global" | "branch" | "person"; scopeId: string | null };
export type BranchMembership = { branchId: string; personId: string; membershipKind: "blood_primary" | "migration" | "administrative" };

const rolePermissions: Readonly<Record<RoleName, readonly PermissionName[]>> = {
  admin: ["system.manage", "lineage.review", "lineage.propose", "person.read_member", "person.read_admin"],
  editor: ["lineage.propose", "person.read_member"],
  member: ["person.read_member"],
  visitor: [],
};

export function hasPermission(roles: readonly RoleName[], permission: PermissionName): boolean {
  return roles.some((role) => rolePermissions[role].includes(permission));
}

/** Shared by every future person, graph, search and export projection. */
export function canReadVisibility(roles: readonly RoleName[], visibility: Visibility): boolean {
  if (visibility === "PUBLIC") return true;
  if (visibility === "MEMBER") return hasPermission(roles, "person.read_member");
  return hasPermission(roles, "person.read_admin");
}

/**
 * A proposal may only affect people the editor has been explicitly assigned.
 * Branch scopes are deliberately not interpreted here: branch membership is a
 * separately versioned administrative projection and must not be inferred from
 * a lineage edge.
 */
export function canProposeForPeople(
  roles: readonly RoleName[],
  scopes: readonly AccountScope[],
  personIds: readonly string[],
): boolean {
  return canProposeForPeopleWithBranchMembership(roles, scopes, personIds, []);
}

/** A branch scope covers only exact, primary-blood members in the proposal's base revision. */
export function canProposeForPeopleWithBranchMembership(
  roles: readonly RoleName[],
  scopes: readonly AccountScope[],
  personIds: readonly string[],
  memberships: readonly BranchMembership[],
): boolean {
  if (!hasPermission(roles, "lineage.propose")) return false;
  if (hasPermission(roles, "system.manage")) return true;
  if (scopes.some((scope) => scope.scopeType === "global")) return true;
  const permittedPeople = new Set(scopes.filter((scope) => scope.scopeType === "person" && scope.scopeId).map((scope) => scope.scopeId));
  const permittedBranches = new Set(scopes.filter((scope) => scope.scopeType === "branch" && scope.scopeId).map((scope) => scope.scopeId));
  for (const membership of memberships) {
    if (membership.membershipKind === "blood_primary" && permittedBranches.has(membership.branchId)) permittedPeople.add(membership.personId);
  }
  return personIds.every((personId) => permittedPeople.has(personId));
}
