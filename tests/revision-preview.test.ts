import { describe, expect, it } from "vitest";
import { previewSuccessionRevision } from "../worker/lineage/revision-preview";

describe("revision succession preview", () => {
  it("reports a valid replacement and its affected child", () => {
    expect(previewSuccessionRevision({
      baseEdges: [{ parentPersonId: "old-parent", childPersonId: "child" }],
      proposedEdges: [{ parentPersonId: "successor-parent", childPersonId: "child" }],
    })).toMatchObject({
      valid: true,
      affectedChildPersonIds: ["child"],
      addedEdgeCount: 1,
      removedEdgeCount: 1,
    });
  });

  it("does not claim an invalid draft is publishable", () => {
    const preview = previewSuccessionRevision({
      baseEdges: [],
      proposedEdges: [
        { parentPersonId: "a", childPersonId: "b" },
        { parentPersonId: "b", childPersonId: "a" },
      ],
    });
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((issue) => issue.code)).toContain("succession_cycle");
  });
});
