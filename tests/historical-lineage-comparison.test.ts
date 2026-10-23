import { describe, expect, it } from "vitest";
import { compareHistoricalLineage } from "../worker/lineage/historical-lineage-comparison";

describe("historical lineage comparison", () => {
  it("does not call an unmapped historical record a canonical difference", () => {
    const comparison = compareHistoricalLineage(
      [{ parentPersonId: "person-parent", childPersonId: "person-child" }],
      {
        nodes: [
          { sourceRecordId: "source-parent", displayName: "父", confirmedPersonId: "person-parent" },
          { sourceRecordId: "source-child", displayName: "子", confirmedPersonId: "person-child" },
          { sourceRecordId: "source-unmapped", displayName: "待考", confirmedPersonId: null },
        ],
        parentChildEdges: [
          { claimId: "same", parentRecordId: "source-parent", childRecordId: "source-child", parentKind: "biological_parent", rawText: "同" },
          { claimId: "unknown", parentRecordId: "source-parent", childRecordId: "source-unmapped", parentKind: "biological_parent", rawText: "待考" },
        ],
        spouseEdges: [], annotations: [],
      },
    );
    expect(comparison.canonicalEdges[0]?.status).toBe("same");
    expect(comparison.historicalEdges.map((edge) => edge.status)).toEqual(["same", "uncomparable"]);
  });
});
