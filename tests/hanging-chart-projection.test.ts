import { describe, expect, it } from "vitest";
import { projectHangingChart } from "../worker/lineage/hanging-chart-projection";

describe("hanging chart projection", () => {
  it("assigns horizontal generation columns without persisting coordinates", () => {
    const result = projectHangingChart([{ id: "a", displayName: "始祖" }, { id: "b", displayName: "子" }, { id: "c", displayName: "孙" }], [
      { parentPersonId: "a", childPersonId: "b", orderKey: "001" }, { parentPersonId: "b", childPersonId: "c", orderKey: "001" },
    ]);
    expect(result.generations).toEqual([{ generation: 0, personIds: ["a"] }, { generation: 1, personIds: ["b"] }, { generation: 2, personIds: ["c"] }]);
    expect(JSON.stringify(result)).not.toContain('"x"');
  });
});
