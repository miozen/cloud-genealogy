import { expect, it } from "vitest";
import { buildSnapshotChangeItems, buildSnapshotMembershipChangeItems, previewChangeRequest } from "../worker/lineage/change-request-preview";

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

it("expresses snapshot rollback as explicit proposal items", () => {
  const items = buildSnapshotChangeItems(
    [{ parentPersonId: "new", childPersonId: "child" }], [],
    [{ parentPersonId: "old", childPersonId: "child" }], [{ subjectPersonId: "child", relatedPersonId: "old", relationKind: "successor_parent" }],
  );
  expect(items).toEqual([
    { operation: "succession_remove", subjectPersonId: "new", relatedPersonId: "child" },
    { operation: "succession_add", subjectPersonId: "old", relatedPersonId: "child" },
    { operation: "relation_add", subjectPersonId: "child", relatedPersonId: "old", relationKind: "successor_parent" },
  ]);
});

it("previews explicit membership changes separately and rejects multiple primary branches", () => {
  const result = previewChangeRequest([], [], [],
    [{ branchId: "branch-a", personId: "person-a", membershipKind: "blood_primary" }],
    [{ operation: "add", branchId: "branch-b", personId: "person-a", membershipKind: "blood_primary" }],
  );
  expect(result.valid).toBe(false);
  expect(result.issues).toContainEqual({ code: "multiple_primary_branch", personIds: ["person-a"] });
  expect(result.memberships).toHaveLength(2);
});

it("expresses membership rollback as explicit add and remove items", () => {
  expect(buildSnapshotMembershipChangeItems(
    [{ branchId: "new", personId: "person", membershipKind: "migration" }],
    [{ branchId: "old", personId: "person", membershipKind: "blood_primary" }],
  )).toEqual([
    { operation: "remove", branchId: "new", personId: "person", membershipKind: "migration" },
    { operation: "add", branchId: "old", personId: "person", membershipKind: "blood_primary" },
  ]);
});

it("rejects parent relations that contradict the published succession direction and deduplicates reverse spouse entries", () => {
  const invalid = previewChangeRequest(
    [{ parentPersonId: "parent", childPersonId: "child" }], [],
    [{ operation: "relation_add", subjectPersonId: "parent", relatedPersonId: "child", relationKind: "biological_parent" }],
  );
  expect(invalid.valid).toBe(false);
  expect(invalid.issues).toContainEqual({ code: "canonical_parent_direction_conflicts_succession", personIds: ["parent", "child"] });
  const spouses = previewChangeRequest([], [], [
    { operation: "relation_add", subjectPersonId: "a", relatedPersonId: "b", relationKind: "spouse" },
    { operation: "relation_add", subjectPersonId: "b", relatedPersonId: "a", relationKind: "spouse" },
  ]);
  expect(spouses.relations).toHaveLength(1);
});
