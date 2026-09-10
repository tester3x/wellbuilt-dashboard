/**
 * Pure claim decision for the targeted per-well recompute consumer.
 *
 * The recompute request carries a version = requestedAtUtc. The consumer claims
 * via a transaction on a SEPARATE status node (so its own writes never re-trigger
 * the request node). This decides whether a firing should proceed:
 *   - no prior status                                   → claim
 *   - same version already completed or processing      → skip (idempotent /
 *                                                          concurrent double-fire)
 *   - same version previously FAILED                    → claim (retry)
 *   - a different (newer) version                       → claim
 */
export interface RecomputeStatus {
  status?: 'processing' | 'completed' | 'failed';
  forRequestedAtUtc?: number;
}

export function decideRecomputeClaim(
  current: RecomputeStatus | null | undefined,
  version: number,
): 'claim' | 'skip' {
  if (!current) return 'claim';
  if (current.forRequestedAtUtc === version) {
    if (current.status === 'completed' || current.status === 'processing') return 'skip';
    return 'claim'; // failed (or unknown) → retry the same version
  }
  return 'claim'; // a different/newer request version
}
