import { describe, expect, it } from "vitest";
import { publishSuccessionRevision } from "../worker/lineage/revision-publish";

function fakeDatabase(lineageExists = true, branchMemberships: unknown[] = []) {
  const statements: unknown[] = [];
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        const statement = { sql, values };
        statements.push(statement);
        return { ...statement, first: async () => (lineageExists ? { id: "lineage" } : null), all: async () => ({ results: branchMemberships }) };
      },
    }),
    batch: async (items: unknown[]) => { statements.push(...items); return []; },
  };
  return { database: database as unknown as D1Database, statements };
}

describe("revision publishing", () => {
  it("does not write an invalid snapshot", async () => {
    const { database, statements } = fakeDatabase();
    const result = await publishSuccessionRevision(database, {
      lineageId: "lineage", revisionId: "r2", baseEdges: [], expectedPointerVersion: 0, now: "2026-01-01T00:00:00Z",
      proposedEdges: [{ parentPersonId: "a", childPersonId: "b" }, { parentPersonId: "b", childPersonId: "a" }],
      audit: { id: "audit-invalid", actorAccountId: "admin", action: "lineage.revision_published", objectType: "lineage_revision", objectId: "r2", metadataJson: "{}" },
    });
    expect(result.published).toBe(false);
    expect(statements).toEqual([]);
  });

  it("writes a complete snapshot and switches only the pointer", async () => {
    const { database, statements } = fakeDatabase(true, [{ branch_id: "branch-a", person_id: "person-a", membership_kind: "blood_primary" }]);
    const result = await publishSuccessionRevision(database, {
      lineageId: "lineage", revisionId: "r2", basedOnRevisionId: "r1", baseEdges: [],
      proposedEdges: [{ parentPersonId: "parent", childPersonId: "child" }], expectedPointerVersion: 1, now: "2026-01-01T00:00:00Z",
      proposedRelations: [{ subjectPersonId: "child", relatedPersonId: "parent", relationKind: "biological_parent" }],
      audit: { id: "audit-1", actorAccountId: "admin", action: "lineage.revision_published", objectType: "lineage_revision", objectId: "r2", metadataJson: "{}" },
    });
    expect(result).toEqual({ published: true, revisionId: "r2" });
    expect(JSON.stringify(statements)).toContain("lineage_published_pointer");
    expect(JSON.stringify(statements)).toContain("expected_pointer_version");
    expect(JSON.stringify(statements)).toContain("lineage.revision_published");
    expect(JSON.stringify(statements)).toContain("canonical_relation_snapshot");
    expect(JSON.stringify(statements)).toContain("branch_membership_snapshot");
    expect(JSON.stringify(statements)).toContain("branch-a");
    expect(JSON.stringify(statements)).not.toContain("UPDATE lineage_revision");
  });
});
