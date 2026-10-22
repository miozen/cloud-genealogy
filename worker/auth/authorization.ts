import type { PermissionName, RoleName } from "../types";

export type Visibility = "PUBLIC" | "MEMBER" | "ADMIN";

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
