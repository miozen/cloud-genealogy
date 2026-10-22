import type { PermissionName, RoleName } from "../types";

const rolePermissions: Readonly<Record<RoleName, readonly PermissionName[]>> = {
  administrator: ["system.manage", "lineage.review", "lineage.propose", "person.read_restricted"],
  reviewer: ["lineage.review", "person.read_restricted"],
  branch_editor: ["lineage.propose"],
  member: [],
  guest: [],
};

export function hasPermission(roles: readonly RoleName[], permission: PermissionName): boolean {
  return roles.some((role) => rolePermissions[role].includes(permission));
}
