import { describe, expect, it } from "vitest";
import { expandHangingChart, layoutHangingChart } from "../worker/lineage/hanging-chart-layout";
import { projectHangingChart } from "../worker/lineage/hanging-chart-projection";

describe("hanging chart layout", () => {
  const projection = projectHangingChart([{ id: "a", displayName: "始" }, { id: "b", displayName: "长子" }, { id: "c", displayName: "次子" }, { id: "d", displayName: "孙" }], [
    { parentPersonId: "a", childPersonId: "b", orderKey: "001" }, { parentPersonId: "a", childPersonId: "c", orderKey: "002" }, { parentPersonId: "b", childPersonId: "d", orderKey: "001" },
  ]);
  it("lays generations horizontally, siblings vertically, with orthogonal connectors", () => {
    const layout = layoutHangingChart(projection);
    expect(layout.nodes.find((node) => node.personId === "b")).toMatchObject({ x: 240, y: 0 });
    expect(layout.nodes.find((node) => node.personId === "c")).toMatchObject({ x: 240, y: 96 });
    expect(layout.connectors[0]?.points).toHaveLength(4);
  });
  it("expands only a selected branch", () => expect(expandHangingChart(projection, "b").nodes.map((node) => node.personId)).toEqual(["b", "d"]));
});
