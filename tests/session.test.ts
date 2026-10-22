import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashOpaqueToken } from "../worker/auth/opaque-token";
import { hasValidCsrfToken, loadActiveSession, requiresCsrfProtection } from "../worker/auth/session";

function createDatabase(session: Record<string, string> | null) {
  return {
    prepare(query: string) {
      return {
        bind() {
          return {
            async first() {
              return query.includes("FROM auth_session") ? session : null;
            },
            async all() {
              return { results: [{ name: "administrator" }] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("active sessions and CSRF", () => {
  it("loads the active account and assigned roles from an opaque session token", async () => {
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const auth = await loadActiveSession(
      createDatabase({
        account_id: "account-1",
        csrf_secret_hash: await hashOpaqueToken(csrfToken),
        email: "admin@example.test",
        display_name: "管理员",
      }),
      token,
    );

    expect(auth).toMatchObject({ accountId: "account-1", roles: ["administrator"] });
    await expect(hasValidCsrfToken("POST", csrfToken, auth!.csrfSecretHash)).resolves.toBe(true);
    await expect(hasValidCsrfToken("POST", "incorrect", auth!.csrfSecretHash)).resolves.toBe(false);
  });

  it("only requires a CSRF token for unsafe methods", () => {
    expect(requiresCsrfProtection("GET")).toBe(false);
    expect(requiresCsrfProtection("HEAD")).toBe(false);
    expect(requiresCsrfProtection("POST")).toBe(true);
    expect(requiresCsrfProtection("DELETE")).toBe(true);
  });
});
