import { describe, expect, it } from "vitest";
import { validateSuccessionEdges } from "../worker/lineage/succession-validation";

describe("succession revision validation", () => {
  it("allows unknown parentage and acyclic edges", () => {
    expect(validateSuccessionEdges([])).toEqual([]);
    expect(validateSuccessionEdges([{ parentPersonId: "ancestor", childPersonId: "child" }])).toEqual([]);
  });

  it("rejects two succession parents for one child", () => {
    expect(validateSuccessionEdges([
      { parentPersonId: "biological", childPersonId: "child" },
      { parentPersonId: "successor", childPersonId: "child" },
    ])).toContainEqual({ code: "multiple_succession_parents", personIds: ["child", "biological", "successor"] });
  });

  it("rejects cycles and self parentage", () => {
    const cycleIssues = validateSuccessionEdges([
      { parentPersonId: "a", childPersonId: "b" },
      { parentPersonId: "b", childPersonId: "c" },
      { parentPersonId: "c", childPersonId: "a" },
    ]);
    const cycle = cycleIssues.find((issue) => issue.code === "succession_cycle");
    expect(cycle?.personIds.sort()).toEqual(["a", "b", "c"]);
    expect(validateSuccessionEdges([{ parentPersonId: "same", childPersonId: "same" }])).toEqual([
      { code: "self_parent", personIds: ["same"] },
    ]);
  });
});
