import { expect, it } from "vitest";
import { layoutHistoricalRecords } from "../src/historical-record-layout";
it("uses a stable source-record grid without assigning generations", () => {
  const layout = layoutHistoricalRecords([{ sourceRecordId: "a", displayName: "甲" }, { sourceRecordId: "b", displayName: "乙" }], [{ claimId: "c", parentRecordId: "a", childRecordId: "b" }]);
  expect(layout.nodes.map((node) => [node.x, node.y])).toEqual([[0, 0], [220, 0]]);
  expect(layout.connectors).toHaveLength(1);
});
