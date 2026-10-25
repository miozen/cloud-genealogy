export const mediaCleanupRunLifetimeMs = 24 * 60 * 60 * 1000;
export const maximumMediaCleanupCandidates = 100;

export type MediaCleanupCandidate = {
  mediaAssetId: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  retiredAt: string;
  cleanupAfter: string;
  historicalLinkCount: number;
};

export type FrozenMediaCleanupRun = {
  id: string;
  state: "pending_confirmation";
  candidateSnapshotSha256: string;
  candidateCount: number;
  backupRecoveryPoint: string;
  backupPackageSha256: string;
  createdByAccountId: string;
  createdAt: string;
  expiresAt: string;
};

export type ConfirmedMediaCleanupRun = Omit<FrozenMediaCleanupRun, "state"> & {
  state: "confirmed";
  confirmedByAccountId: string;
  confirmedAt: string;
};
export type CancelledMediaCleanupRun = Omit<FrozenMediaCleanupRun, "state"> & {
  state: "cancelled";
  cancelledByAccountId: string;
  cancelledAt: string;
};
export type ExpiredMediaCleanupRun = Omit<FrozenMediaCleanupRun, "state"> & { state: "expired" };
export type FrozenMediaCleanupItem = {
  mediaAssetId: string;
  expectedObjectKey: string;
  expectedSha256: string;
  expectedByteSize: number;
  expectedRetiredAt: string;
  expectedCleanupAfter: string;
  expectedHistoricalLinkCount: number;
};
export type CurrentMediaCleanupAsset = {
  state: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  retiredAt: string | null;
  cleanupAfter: string | null;
  activeReferenceCount: number;
  historicalLinkCount: number;
};

function isSha256(value: string) { return /^[0-9a-f]{64}$/.test(value); }
function isTimestamp(value: string) { return Number.isFinite(Date.parse(value)); }

function canonicalCandidates(candidates: readonly MediaCleanupCandidate[]) {
  return [...candidates]
    .sort((left, right) => left.cleanupAfter.localeCompare(right.cleanupAfter) || left.mediaAssetId.localeCompare(right.mediaAssetId))
    .map(({ mediaAssetId, objectKey, sha256, byteSize, retiredAt, cleanupAfter, historicalLinkCount }) => ({ mediaAssetId, objectKey, sha256, byteSize, retiredAt, cleanupAfter, historicalLinkCount }));
}

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateCandidate(candidate: MediaCleanupCandidate, now: Date) {
  if (!candidate.mediaAssetId || !candidate.objectKey || !isSha256(candidate.sha256)) throw new Error("media_cleanup_candidate_invalid");
  if (!Number.isInteger(candidate.byteSize) || candidate.byteSize < 1 || !Number.isInteger(candidate.historicalLinkCount) || candidate.historicalLinkCount < 0) throw new Error("media_cleanup_candidate_invalid");
  if (!isTimestamp(candidate.retiredAt) || !isTimestamp(candidate.cleanupAfter) || Date.parse(candidate.cleanupAfter) > now.getTime()) throw new Error("media_cleanup_candidate_not_due");
}

export async function freezeMediaCleanupRun(
  input: { id: string; createdByAccountId: string; backupRecoveryPoint: string; backupPackageSha256: string; candidates: readonly MediaCleanupCandidate[] },
  now: Date,
): Promise<{ run: FrozenMediaCleanupRun; candidates: MediaCleanupCandidate[] }> {
  if (!input.id || !input.createdByAccountId || !input.backupRecoveryPoint.trim() || input.backupRecoveryPoint.length > 255 || !isSha256(input.backupPackageSha256)) throw new Error("media_cleanup_run_invalid");
  if (input.candidates.length < 1 || input.candidates.length > maximumMediaCleanupCandidates) throw new Error("media_cleanup_candidate_count_invalid");
  const candidateIds = new Set<string>();
  const candidateKeys = new Set<string>();
  for (const candidate of input.candidates) {
    validateCandidate(candidate, now);
    if (candidateIds.has(candidate.mediaAssetId) || candidateKeys.has(candidate.objectKey)) throw new Error("media_cleanup_candidate_duplicate");
    candidateIds.add(candidate.mediaAssetId); candidateKeys.add(candidate.objectKey);
  }
  const candidates = canonicalCandidates(input.candidates);
  const createdAt = now.toISOString();
  return {
    run: {
      id: input.id,
      state: "pending_confirmation",
      candidateSnapshotSha256: await sha256(JSON.stringify(candidates)),
      candidateCount: candidates.length,
      backupRecoveryPoint: input.backupRecoveryPoint.trim(),
      backupPackageSha256: input.backupPackageSha256,
      createdByAccountId: input.createdByAccountId,
      createdAt,
      expiresAt: new Date(now.getTime() + mediaCleanupRunLifetimeMs).toISOString(),
    },
    candidates,
  };
}

export function confirmMediaCleanupRun(run: FrozenMediaCleanupRun, confirmedByAccountId: string, now: Date): ConfirmedMediaCleanupRun {
  if (now.getTime() >= Date.parse(run.expiresAt)) throw new Error("media_cleanup_run_expired");
  if (!confirmedByAccountId || confirmedByAccountId === run.createdByAccountId) throw new Error("media_cleanup_second_confirmer_invalid");
  return { ...run, state: "confirmed", confirmedByAccountId, confirmedAt: now.toISOString() };
}

export function cancelMediaCleanupRun(run: FrozenMediaCleanupRun, cancelledByAccountId: string, now: Date): CancelledMediaCleanupRun {
  if (!cancelledByAccountId) throw new Error("media_cleanup_canceller_invalid");
  return { ...run, state: "cancelled", cancelledByAccountId, cancelledAt: now.toISOString() };
}

export function expireMediaCleanupRun(run: FrozenMediaCleanupRun, now: Date): ExpiredMediaCleanupRun {
  if (now.getTime() < Date.parse(run.expiresAt)) throw new Error("media_cleanup_run_not_expired");
  return { ...run, state: "expired" };
}

export function previewMediaCleanupItem(item: FrozenMediaCleanupItem, current: CurrentMediaCleanupAsset | null, now: Date) {
  if (!current) return { status: "would_skip" as const, blockingCodes: ["media_asset_missing"] };
  const blockingCodes = [
    ...(current.state !== "retired" ? ["media_asset_not_retired"] : []),
    ...(current.objectKey !== item.expectedObjectKey ? ["object_key_changed"] : []),
    ...(current.sha256 !== item.expectedSha256 ? ["sha256_changed"] : []),
    ...(current.byteSize !== item.expectedByteSize ? ["byte_size_changed"] : []),
    ...(current.retiredAt !== item.expectedRetiredAt ? ["retired_at_changed"] : []),
    ...(current.cleanupAfter !== item.expectedCleanupAfter ? ["cleanup_after_changed"] : []),
    ...(current.cleanupAfter === null || Date.parse(current.cleanupAfter) > now.getTime() ? ["cleanup_not_due"] : []),
    ...(current.activeReferenceCount !== 0 ? ["active_reference_exists"] : []),
    ...(current.historicalLinkCount !== item.expectedHistoricalLinkCount ? ["historical_link_count_changed"] : []),
  ];
  return { status: blockingCodes.length === 0 ? "ready_for_future_execution" as const : "would_skip" as const, blockingCodes };
}
