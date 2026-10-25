import { describe, expect, it } from "vitest";
import { cancelMediaCleanupRun, confirmMediaCleanupRun, expireMediaCleanupRun, freezeMediaCleanupRun, maximumMediaCleanupCandidates } from "../worker/media/media-cleanup-run";

const now = new Date("2026-10-25T00:00:00.000Z");
const candidate = {
  mediaAssetId: "asset-a", objectKey: "media/asset-a", sha256: "a".repeat(64), byteSize: 128,
  retiredAt: "2026-09-01T00:00:00.000Z", cleanupAfter: "2026-10-01T00:00:00.000Z", historicalLinkCount: 1,
};
const input = { id: "run-a", createdByAccountId: "admin-a", backupRecoveryPoint: "backup-2026-10-24", backupPackageSha256: "b".repeat(64), candidates: [candidate] };

describe("media cleanup run state", () => {
  it("freezes a bounded deterministic candidate snapshot with backup evidence", async () => {
    const first = await freezeMediaCleanupRun({ ...input, candidates: [candidate, { ...candidate, mediaAssetId: "asset-b", objectKey: "media/asset-b" }] }, now);
    const second = await freezeMediaCleanupRun({ ...input, candidates: [{ ...candidate, mediaAssetId: "asset-b", objectKey: "media/asset-b" }, candidate] }, now);
    expect(first.run).toMatchObject({ state: "pending_confirmation", candidateCount: 2, expiresAt: "2026-10-26T00:00:00.000Z" });
    expect(first.run.candidateSnapshotSha256).toBe(second.run.candidateSnapshotSha256);
    expect(first.candidates.map((item) => item.mediaAssetId)).toEqual(["asset-a", "asset-b"]);
  });

  it("rejects non-due, duplicate, oversized, and unproven cleanup snapshots", async () => {
    await expect(freezeMediaCleanupRun({ ...input, candidates: [{ ...candidate, cleanupAfter: "2026-10-26T00:00:00.000Z" }] }, now)).rejects.toThrow("media_cleanup_candidate_not_due");
    await expect(freezeMediaCleanupRun({ ...input, candidates: [candidate, candidate] }, now)).rejects.toThrow("media_cleanup_candidate_duplicate");
    await expect(freezeMediaCleanupRun({ ...input, candidates: Array.from({ length: maximumMediaCleanupCandidates + 1 }, (_, index) => ({ ...candidate, mediaAssetId: `asset-${index}`, objectKey: `media/asset-${index}` })) }, now)).rejects.toThrow("media_cleanup_candidate_count_invalid");
    await expect(freezeMediaCleanupRun({ ...input, backupPackageSha256: "bad" }, now)).rejects.toThrow("media_cleanup_run_invalid");
  });

  it("requires a different second administrator before a run can be confirmed", async () => {
    const { run } = await freezeMediaCleanupRun(input, now);
    expect(() => confirmMediaCleanupRun(run, "admin-a", now)).toThrow("media_cleanup_second_confirmer_invalid");
    expect(() => confirmMediaCleanupRun(run, "admin-b", new Date("2026-10-26T00:00:00.000Z"))).toThrow("media_cleanup_run_expired");
    expect(confirmMediaCleanupRun(run, "admin-b", new Date("2026-10-25T01:00:00.000Z"))).toMatchObject({ state: "confirmed", confirmedByAccountId: "admin-b" });
  });

  it("allows a pending run to be cancelled or explicitly converged to expired", async () => {
    const { run } = await freezeMediaCleanupRun(input, now);
    expect(cancelMediaCleanupRun(run, "admin-b", now)).toMatchObject({ state: "cancelled", cancelledByAccountId: "admin-b" });
    expect(() => cancelMediaCleanupRun(run, "", now)).toThrow("media_cleanup_canceller_invalid");
    expect(() => expireMediaCleanupRun(run, now)).toThrow("media_cleanup_run_not_expired");
    expect(expireMediaCleanupRun(run, new Date("2026-10-26T00:00:00.000Z"))).toMatchObject({ state: "expired" });
  });
});
