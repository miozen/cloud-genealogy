import { describe, expect, it } from "vitest";
import { reviewSnapshot, type ReviewSnapshot } from "./fixtures/readiness-review-model";

const baseline: ReviewSnapshot = { expectedFreezeId: "fixture-freeze", expectedEpoch: 2, freezeId: "fixture-freeze", epoch: 2, freezeStillHeld: true, openAdmissions: 0, reportedFixtureRecoveries: 0, admissionsTruncated: false, pendingUploads: 0, unexpiredUrls: 0, uploadListingTruncated: false, writerInventory: "fixture_verified", directUploadDrain: "fixture_verified" };

describe("review-only readiness counterexamples", () => {
  it("never enables execution even for an idealized synthetic scenario", () => {
    expect(reviewSnapshot(baseline)).toEqual({ blockers: [], simulatedCandidate: true, remoteExecutionAvailable: false });
  });
  it.each([
    [{ freezeId: null }, "freeze_unknown_or_changed"],
    [{ freezeId: "other" }, "freeze_unknown_or_changed"],
    [{ epoch: 3 }, "freeze_unknown_or_changed"],
    [{ freezeStillHeld: false }, "freeze_unknown_or_changed"],
    [{ openAdmissions: null }, "admission_snapshot_incomplete"],
    [{ openAdmissions: -1 }, "admission_snapshot_incomplete"],
    [{ admissionsTruncated: true }, "admission_snapshot_incomplete"],
    [{ openAdmissions: 1, reportedFixtureRecoveries: 1 }, "open_admissions"],
    [{ openAdmissions: 0, reportedFixtureRecoveries: 1 }, "admission_snapshot_incomplete"],
    [{ pendingUploads: null }, "upload_snapshot_incomplete"],
    [{ unexpiredUrls: Number.NaN }, "upload_snapshot_incomplete"],
    [{ uploadListingTruncated: true }, "upload_snapshot_incomplete"],
    [{ pendingUploads: 1 }, "pending_uploads"],
    [{ unexpiredUrls: 1 }, "unexpired_urls"],
    [{ writerInventory: "unknown" as const }, "writer_inventory_unverified"],
    [{ directUploadDrain: "unknown" as const }, "direct_upload_drain_unverified"],
  ])("blocks %j as %s", (change, reason) => {
    const result = reviewSnapshot({ ...baseline, ...change });
    expect(result.blockers).toContain(reason);
    expect(result.simulatedCandidate).toBe(false);
    expect(result.remoteExecutionAvailable).toBe(false);
  });
});
