import { describe, expect, it } from "vitest";
import { publishSuccessionRevision, type PublishRevisionInput } from "../worker/lineage/revision-publish";

function fakeDatabase(lineageExists = true, branchMemberships: unknown[] = [], branchStructures: unknown[] = []) {
  const statements: unknown[] = [];
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        const statement = { sql, values };
        statements.push(statement);
        return { ...statement, first: async () => (lineageExists ? { id: "lineage" } : null), all: async () => ({ results: sql.includes("branch_structure_snapshot") ? branchStructures : branchMemberships }) };
      },
    }),
    batch: async (items: unknown[]) => { statements.push(...items); return []; },
  };
  return { database: database as unknown as D1Database, statements };
}

describe("revision publishing", () => {
  it.each([undefined, "", "   "])("refuses missing admission %j before querying or writing", async (admissionId) => {
    const { database, statements } = fakeDatabase();
    const input = { admissionId, lineageId: "lineage", revisionId: "r2", baseEdges: [], proposedEdges: [], expectedPointerVersion: 0, now: "2026-01-01T00:00:00Z", audit: { id: "audit", actorAccountId: "admin", action: "lineage.revision_published", objectType: "lineage_revision", objectId: "r2", metadataJson: "{}" } } as unknown as PublishRevisionInput;
    await expect(publishSuccessionRevision(database, input)).rejects.toThrow("backup_admission_missing");
    expect(statements).toEqual([]);
  });

  it("does not write an invalid snapshot", async () => {
    const { database, statements } = fakeDatabase();
    const result = await publishSuccessionRevision(database, {
      admissionId: "fixture-admission", lineageId: "lineage", revisionId: "r2", baseEdges: [], expectedPointerVersion: 0, now: "2026-01-01T00:00:00Z",
      proposedEdges: [{ parentPersonId: "a", childPersonId: "b" }, { parentPersonId: "b", childPersonId: "a" }],
      audit: { id: "audit-invalid", actorAccountId: "admin", action: "lineage.revision_published", objectType: "lineage_revision", objectId: "r2", metadataJson: "{}" },
    });
    expect(result.published).toBe(false);
    expect(statements).toEqual([]);
  });

  it("writes a complete snapshot and switches only the pointer", async () => {
    const { database, statements } = fakeDatabase(true, [{ branch_id: "branch-a", person_id: "person-a", membership_kind: "blood_primary" }], [{ branch_id: "branch-a", parent_branch_id: null, name: "长房", branch_kind: "agnatic", retired_at: null }]);
    const result = await publishSuccessionRevision(database, {
      admissionId: "fixture-admission", lineageId: "lineage", revisionId: "r2", basedOnRevisionId: "r1", baseEdges: [],
      proposedEdges: [{ parentPersonId: "parent", childPersonId: "child" }], expectedPointerVersion: 1, now: "2026-01-01T00:00:00Z",
      proposedRelations: [{ subjectPersonId: "child", relatedPersonId: "parent", relationKind: "biological_parent" }],
      audit: { id: "audit-1", actorAccountId: "admin", action: "lineage.revision_published", objectType: "lineage_revision", objectId: "r2", metadataJson: "{}" },
    });
    expect(result).toEqual({ published: true, revisionId: "r2" });
    expect(JSON.stringify(statements)).toContain("backup_write_fence_check");
    expect(JSON.stringify(statements)).toContain("fixture-admission");
    expect(JSON.stringify(statements)).toContain("lineage_published_pointer");
    expect(JSON.stringify(statements)).toContain("expected_pointer_version");
    expect(JSON.stringify(statements)).toContain("lineage.revision_published");
    expect(JSON.stringify(statements)).toContain("canonical_relation_snapshot");
    expect(JSON.stringify(statements)).toContain("branch_membership_snapshot");
    expect(JSON.stringify(statements)).toContain("branch_structure_snapshot");
    expect(JSON.stringify(statements)).toContain("branch-a");
    expect(JSON.stringify(statements)).not.toContain("UPDATE lineage_revision");
  });

  it("uses explicitly previewed membership snapshot when publishing a change request", async () => {
    const { database, statements } = fakeDatabase(true, [{ branch_id: "old", person_id: "person", membership_kind: "migration" }], [{ branch_id: "old", parent_branch_id: null, name: "旧房", branch_kind: "migration", retired_at: null }]);
    await publishSuccessionRevision(database, {
      admissionId: "fixture-admission", lineageId: "lineage", revisionId: "r2", basedOnRevisionId: "r1", baseEdges: [], proposedEdges: [], expectedPointerVersion: 1, now: "2026-01-01T00:00:00Z",
      proposedBranchMemberships: [{ branch_id: "new", person_id: "person", membership_kind: "blood_primary" }],
      audit: { id: "audit-membership", actorAccountId: "admin", action: "lineage.change_request_published", objectType: "change_request", objectId: "request", metadataJson: "{}" },
    });
    expect(JSON.stringify(statements)).toContain("new");
    const membershipStatements = (statements as Array<{ sql?: string; values?: unknown[] }>).filter((statement) => statement.sql?.includes("branch_membership_snapshot"));
    expect(JSON.stringify(membershipStatements)).not.toContain('"old"');
  });
});
