export interface Env {
  APP_ENV: "development" | "preview" | "production";
  AUTH_RATE_LIMIT_SECRET: string;
  DB: D1Database;
  MEDIA: R2Bucket;
}

export interface AuthContext {
  accountId: string;
  username: string;
  displayName: string;
  csrfSecretHash: string;
  roles: RoleName[];
}

export interface AppVariables {
  auth: AuthContext | null;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

export type RoleName = "visitor" | "member" | "editor" | "admin";

export type PermissionName =
  | "system.manage"
  | "lineage.review"
  | "lineage.propose"
  | "person.read_member"
  | "person.read_admin";
