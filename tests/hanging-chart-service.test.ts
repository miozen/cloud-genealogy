import { describe, expect, it } from "vitest";
import { buildPublishedHangingChart } from "../worker/lineage/hanging-chart-service";

describe("published hanging-chart read model", () => {
  it("keeps persistence out of the projection and can return one expanded branch", () => {
    const chart = buildPublishedHangingChart(
      [{ id: "a", displayName: "始祖" }, { id: "b", displayName: "长子" }, { id: "c", displayName: "次子" }, { id: "d", displayName: "孙" }],
      [
        { parentPersonId: "a", childPersonId: "b", orderKey: "001" },
        { parentPersonId: "a", childPersonId: "c", orderKey: "002" },
        { parentPersonId: "b", childPersonId: "d", orderKey: "001" },
      ],
      "b",
    );

    expect(chart.projection.nodes.map((node) => node.personId)).toEqual(["b", "d"]);
    expect(chart.layout.nodes).toEqual([
      { personId: "b", generation: 1, x: 240, y: 0 },
      { personId: "d", generation: 2, x: 480, y: 0 },
    ]);
  });
});
