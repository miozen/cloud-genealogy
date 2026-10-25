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
