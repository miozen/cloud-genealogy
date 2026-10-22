export interface Env {
  APP_ENV: "development" | "preview" | "production";
  DB: D1Database;
  MEDIA: R2Bucket;
}

export type RoleName = "administrator" | "reviewer" | "branch_editor" | "member" | "guest";

export type PermissionName =
  | "system.manage"
  | "lineage.review"
  | "lineage.propose"
  | "person.read_restricted";
