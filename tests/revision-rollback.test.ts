import { describe, expect, it } from "vitest";
import { buildRollbackEdges, rollbackSuccessionRevision } from "../worker/lineage/revision-publish";

describe("revision rollback", () => {
  it("reads historical snapshot edges without changing the historical revision", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [
            { parent_person_id: "ancestor", child_person_id: "child" },
          ] }),
        }),
      }),
    } as unknown as D1Database;
    await expect(buildRollbackEdges(database, "historical-revision")).resolves.toEqual([
      { parentPersonId: "ancestor", childPersonId: "child" },
    ]);
  });
});

describe("rollback publishing", () => {
  it("refuses a lineage without a current published pointer", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    } as unknown as D1Database;
    await expect(rollbackSuccessionRevision(database, {
      lineageId: "lineage", targetRevisionId: "old", newRevisionId: "new", expectedPointerVersion: 1, now: "2026-01-01T00:00:00Z",
    })).rejects.toThrow("no published revision");
  });
});
