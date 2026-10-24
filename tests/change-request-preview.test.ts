import { expect, it } from "vitest";
import { previewChangeRequest } from "../worker/lineage/change-request-preview";

it("applies explicit succession and relation proposal items without touching the base snapshot", () => {
  const result = previewChangeRequest(
    [{ parentPersonId: "a", childPersonId: "b" }],
    [{ subjectPersonId: "b", relatedPersonId: "a", relationKind: "biological_parent" }],
    [
      { operation: "succession_remove", subjectPersonId: "a", relatedPersonId: "b" },
      { operation: "succession_add", subjectPersonId: "c", relatedPersonId: "b" },
      { operation: "relation_add", subjectPersonId: "b", relatedPersonId: "c", relationKind: "successor_parent" },
    ],
  );
  expect(result.valid).toBe(true);
  expect(result.edges).toEqual([{ parentPersonId: "c", childPersonId: "b" }]);
  expect(result.relations).toHaveLength(2);
});
