import { expect, it } from "vitest";
import { projectKinship } from "../worker/lineage/kinship-projection";
it("keeps parent types and spouse edges beside the selected person", () => {
  const graph = projectKinship("child", [{ id: "child", displayName: "子" }, { id: "bio", displayName: "生父" }, { id: "spouse", displayName: "配偶" }], [{ subjectPersonId: "child", relatedPersonId: "bio", relationKind: "biological_parent" }, { subjectPersonId: "child", relatedPersonId: "spouse", relationKind: "spouse" }]);
  expect(graph.nodes).toHaveLength(3); expect(graph.relations.map((edge) => edge.relationKind)).toEqual(["biological_parent", "spouse"]);
});
