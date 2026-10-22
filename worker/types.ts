export interface Env {
  APP_ENV: "development" | "preview" | "production";
  AUTH_RATE_LIMIT_SECRET: string;
  DB: D1Database;
  MEDIA: R2Bucket;
}

export interface AuthContext {
  accountId: string;
  email: string;
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

export type RoleName = "administrator" | "reviewer" | "branch_editor" | "member" | "guest";

export type PermissionName =
  | "system.manage"
  | "lineage.review"
  | "lineage.propose"
  | "person.read_restricted";
