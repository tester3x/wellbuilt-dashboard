// wellFence.ts — pure per-well fencing primitive (serialization authority).
//
// A TTL-only lease is NOT sufficient: a paused stale holder could commit after
// its lease expired and another worker took ownership. This adds:
//   - a UNIQUE lease token per acquisition;
//   - a MONOTONIC fence sequence that increments on every acquisition;
//   - a final commit that is CONDITIONAL on the current token AND fence still
//     being the ones the worker claimed.
// Therefore, once B takes ownership (new token, higher fence), a resumed A whose
// token no longer matches CANNOT commit — the classic fencing guarantee.
//
// Pure/injected: the RTDB integration applies planAcquire in a transaction on
// wells/<well>/status/chronoFence and gates the final multi-location update on
// canCommit re-checked inside a second transaction.

export interface FenceRecord {
  token: string;
  fence: number;
  expiresAt: number;
}

export type AcquireDecision =
  | { decision: 'acquire'; next: FenceRecord }
  | { decision: 'contended'; heldBy: string; until: number };

/**
 * Decide whether `token` may take the well fence. Acquirable when there is no
 * record, or the current lease has expired. Every acquisition bumps the fence
 * (monotonic), so a later owner always holds a strictly greater fence.
 */
export function planAcquire(
  cur: FenceRecord | null | undefined,
  token: string,
  nowMs: number,
  leaseMs: number,
): AcquireDecision {
  const held = cur && typeof cur.expiresAt === 'number' && cur.expiresAt > nowMs;
  if (held && cur!.token !== token) {
    return { decision: 'contended', heldBy: cur!.token, until: cur!.expiresAt };
  }
  const baseFence = cur && Number.isFinite(cur.fence) ? cur.fence : 0;
  // Re-acquiring our own live lease is a renewal (same token, bumped fence+expiry).
  return { decision: 'acquire', next: { token, fence: baseFence + 1, expiresAt: nowMs + leaseMs } };
}

/**
 * The commit is allowed ONLY if the current fence record still carries the exact
 * token and fence this worker claimed. A stale holder whose lease was taken by
 * another worker fails here — it can never overwrite the newer owner.
 */
export function canCommit(cur: FenceRecord | null | undefined, myToken: string, myFence: number): boolean {
  return !!cur && cur.token === myToken && cur.fence === myFence;
}

/** Release only if the fence is still ours (never clobber a newer owner). */
export function planRelease(cur: FenceRecord | null | undefined, myToken: string): FenceRecord | null {
  if (cur && cur.token === myToken) return null; // clear
  return (cur ?? null); // leave a newer owner's record intact
}
