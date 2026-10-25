import { expect, it } from "vitest";
import { layoutHistoricalReading } from "../src/historical-reading-layout";

it("layers explicit source edges while preserving a cycle as a conflict group", () => {
  const layout = layoutHistoricalReading(
    [{ sourceRecordId: "a", displayName: "甲" }, { sourceRecordId: "b", displayName: "乙" }, { sourceRecordId: "c", displayName: "丙" }, { sourceRecordId: "orphan", displayName: "未连通" }],
    [{ claimId: "ab", parentRecordId: "a", childRecordId: "b" }, { claimId: "bc", parentRecordId: "b", childRecordId: "c" }, { claimId: "cb", parentRecordId: "c", childRecordId: "b" }],
    [{ claimId: "spouse", leftRecordId: "a", rightRecordId: "b" }],
  );
  const byId = new Map(layout.nodes.map((node) => [node.sourceRecordId, node]));
  expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
  expect(byId.get("b")!.conflict).toBe(true);
  expect(byId.get("c")!.conflict).toBe(true);
  expect(layout.spouseConnectors).toHaveLength(1);
  expect(layout.unconnectedRecordIds).toEqual(["orphan"]);
});
