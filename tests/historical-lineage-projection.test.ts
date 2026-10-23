import { describe, expect, it } from "vitest";
import { projectHistoricalLineage } from "../worker/lineage/historical-lineage-projection";

describe("historical lineage projection", () => {
  it("only turns explicitly interpreted source claims into directed graph edges", () => {
    const projection = projectHistoricalLineage(
      [
        { id: "source-parent", displayName: "父", confirmedPersonId: "person-parent" },
        { id: "source-child", displayName: "子", confirmedPersonId: null },
      ],
      [
        { id: "claim-parent", subjectRecordId: "source-parent", relatedRecordId: "source-child", relationKind: "父记子", rawText: "父子原文" },
        { id: "claim-unknown", subjectRecordId: "source-child", relatedRecordId: "source-parent", relationKind: "世系不明", rawText: "待考原文" },
      ],
      [{ relationKind: "父记子", graphKind: "parent_to_child", parentKind: "biological_parent" }],
    );

    expect(projection.parentChildEdges).toEqual([{
      claimId: "claim-parent", parentRecordId: "source-parent", childRecordId: "source-child", parentKind: "biological_parent", rawText: "父子原文",
    }]);
    expect(projection.annotations).toEqual([{
      claimId: "claim-unknown", status: "pending_interpretation", relationKind: "世系不明", rawText: "待考原文",
    }]);
    expect(projection.nodes.find((node) => node.sourceRecordId === "source-child")?.confirmedPersonId).toBeNull();
  });

  it("keeps intentionally non-graph and incomplete claims distinct from unknown terms", () => {
    const projection = projectHistoricalLineage(
      [{ id: "record", displayName: "某", confirmedPersonId: null }],
      [
        { id: "note", subjectRecordId: "record", relatedRecordId: null, relationKind: "注记", rawText: "旁注" },
        { id: "missing", subjectRecordId: "record", relatedRecordId: null, relationKind: "父记子", rawText: "失考" },
      ],
      [
        { relationKind: "注记", graphKind: "non_graph", parentKind: null },
        { relationKind: "父记子", graphKind: "parent_to_child", parentKind: "biological_parent" },
      ],
    );
    expect(projection.annotations.map((annotation) => annotation.status)).toEqual(["not_graphable", "incomplete"]);
  });
});
