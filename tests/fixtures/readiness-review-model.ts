/** Review-only thought experiment: all evidence states are synthetic. Never use for actual readiness. */
export type ReviewSnapshot = {
  expectedFreezeId: string;
  expectedEpoch: number;
  freezeId: string | null;
  epoch: number | null;
  freezeStillHeld: boolean;
  openAdmissions: number | null;
  reportedFixtureRecoveries: number | null;
  admissionsTruncated: boolean;
  pendingUploads: number | null;
  unexpiredUrls: number | null;
  uploadListingTruncated: boolean;
  writerInventory: "fixture_verified" | "unknown";
  directUploadDrain: "fixture_verified" | "unknown";
};

/** This returns a simulated candidate only; it cannot authorize remote execution. */
export function reviewSnapshot(input: ReviewSnapshot) {
  const blockers: string[] = [];
  const validCount = (value: number | null) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!input.expectedFreezeId || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1 || input.freezeId !== input.expectedFreezeId || input.epoch !== input.expectedEpoch || input.freezeStillHeld !== true) blockers.push("freeze_unknown_or_changed");
  if (!validCount(input.openAdmissions) || !validCount(input.reportedFixtureRecoveries) || input.admissionsTruncated !== false || (input.reportedFixtureRecoveries ?? 0) > (input.openAdmissions ?? -1)) blockers.push("admission_snapshot_incomplete");
  // Fixture recovery records never reduce the current application's open count.
  if (validCount(input.openAdmissions) && input.openAdmissions! > 0) blockers.push("open_admissions");
  if (!validCount(input.pendingUploads) || !validCount(input.unexpiredUrls) || input.uploadListingTruncated !== false) blockers.push("upload_snapshot_incomplete");
  if (validCount(input.pendingUploads) && input.pendingUploads! > 0) blockers.push("pending_uploads");
  if (validCount(input.unexpiredUrls) && input.unexpiredUrls! > 0) blockers.push("unexpired_urls");
  if (input.writerInventory !== "fixture_verified") blockers.push("writer_inventory_unverified");
  if (input.directUploadDrain !== "fixture_verified") blockers.push("direct_upload_drain_unverified");
  return { blockers, simulatedCandidate: blockers.length === 0, remoteExecutionAvailable: false as const };
}
