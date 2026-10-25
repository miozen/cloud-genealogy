import { expect, it } from "vitest";
import { boundedKinship, projectKinship } from "../worker/lineage/kinship-projection";
it("keeps parent types and spouse edges beside the selected person", () => {
  const graph = projectKinship("child", [{ id: "child", displayName: "子" }, { id: "bio", displayName: "生父" }, { id: "spouse", displayName: "配偶" }], [{ subjectPersonId: "child", relatedPersonId: "bio", relationKind: "biological_parent" }, { subjectPersonId: "child", relatedPersonId: "spouse", relationKind: "spouse" }]);
  expect(graph.nodes).toHaveLength(3); expect(graph.relations.map((edge) => edge.relationKind)).toEqual(["biological_parent", "spouse"]);
});

it("expands no farther than the requested radius with stable distances", () => {
  const graph = boundedKinship("center", [
    { id: "center", displayName: "中心" }, { id: "parent", displayName: "父" }, { id: "grandparent", displayName: "祖" }, { id: "spouse", displayName: "配偶" },
  ], [
    { subjectPersonId: "center", relatedPersonId: "parent", relationKind: "biological_parent" },
    { subjectPersonId: "parent", relatedPersonId: "grandparent", relationKind: "biological_parent" },
    { subjectPersonId: "center", relatedPersonId: "spouse", relationKind: "spouse" },
  ], 2);
  expect(graph.nodes.map((node) => [node.id, node.distance])).toEqual([["center", 0], ["parent", 1], ["spouse", 1], ["grandparent", 2]]);
  expect(graph.relations).toHaveLength(3);
  expect(graph.truncated).toBe(false);
});

it("truncates at the server-supplied node cap without exposing excluded nodes", () => {
  const people = [{ id: "center", displayName: "中心" }, ...Array.from({ length: 4 }, (_, index) => ({ id: `p-${index}`, displayName: `人物${index}` }))];
  const graph = boundedKinship("center", people, people.slice(1).map((person) => ({ subjectPersonId: "center", relatedPersonId: person.id, relationKind: "spouse" as const })), 1, { nodes: 3, relations: 10 });
  expect(graph.truncated).toBe(true);
  expect(graph.nodes.map((node) => node.id)).toEqual(["center", "p-0", "p-1"]);
  expect(graph.relations).toHaveLength(2);
});
