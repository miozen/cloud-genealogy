import { describe, expect, it } from "vitest";
import { isBackupProtectedWrite } from "../worker/backup/write-freeze";

describe("backup write freeze route policy", () => {
  it("blocks administrative business writes while preserving reads and in-memory previews", () => {
    expect(isBackupProtectedWrite("POST", "/api/admin/persons")).toBe(true);
    expect(isBackupProtectedWrite("PUT", "/api/admin/accounts/id/scopes")).toBe(true);
    expect(isBackupProtectedWrite("GET", "/api/admin/persons")).toBe(false);
    expect(isBackupProtectedWrite("POST", "/api/admin/lineages/id/revisions/preview")).toBe(false);
  });

  it("does not make freeze administration or authentication impossible", () => {
    expect(isBackupProtectedWrite("POST", "/api/admin/backup-write-freeze")).toBe(false);
    expect(isBackupProtectedWrite("POST", "/api/admin/backup-write-freeze/release")).toBe(false);
    expect(isBackupProtectedWrite("POST", "/api/auth/login")).toBe(false);
  });
});
