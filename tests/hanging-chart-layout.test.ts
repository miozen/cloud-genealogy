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

  it("keeps a synthetic 1000-person chart deterministic and non-overlapping", () => {
    const people = Array.from({ length: 1000 }, (_, index) => ({ id: `p-${index}`, displayName: `人物${index}` }));
    const edges = people.slice(1).map((person, index) => ({
      parentPersonId: `p-${Math.floor(index / 3)}`,
      childPersonId: person.id,
      orderKey: String(index % 3).padStart(3, "0"),
    }));
    const full = projectHangingChart(people, edges);
    const layout = layoutHangingChart(full);
    const expanded = expandHangingChart(full, "p-1");

    expect(layout.nodes).toHaveLength(1000);
    expect(new Set(layout.nodes.map((node) => `${node.x}:${node.y}`))).toHaveLength(1000);
    expect(layout.nodes.every((node) => node.x === node.generation * 240 && node.y % 96 === 0)).toBe(true);
    expect(expanded.nodes.map((node) => node.personId)).toEqual(expandHangingChart(full, "p-1").nodes.map((node) => node.personId));
  });
});
