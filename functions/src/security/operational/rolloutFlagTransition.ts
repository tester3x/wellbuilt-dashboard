// rolloutFlagTransition.ts — the compare-and-set decision for the WB-M mutation
// admission flag (predeploy gate Rev-4 Blocker 2). A read-then-set() is
// TOCTOU-prone; the executor runs this decision INSIDE an RTDB transaction so
// the prior value it sees is the committed one and exactly one transition wins.
//
// The flag stays backward compatible with the deployed producer gate
// (decideAdmission reads `paused === true`); CLOSE sets paused:true and REOPEN
// sets paused:false, both carrying governed metadata for diagnosing an
// interrupted rollout. The authoritative `changedAt` is a server timestamp
// stamped by the executor, never a workstation clock.

export type FlagState = 'OPEN' | 'CLOSED';

export interface RolloutFlag {
  paused: boolean;        // producer-gate compatibility (decideAdmission)
  state: FlagState;       // governed label
  rolloutId: string;
  reviewedSha: string;
  changedAt: unknown;     // server timestamp (sentinel filled by executor)
  changedBy: string;
  reason: string;
}

export interface TransitionIntent {
  op: 'close' | 'reopen';
  rolloutId: string;
  reviewedSha: string;
  changedBy: string;
  reason: string;
}

export type TransitionDecision =
  | { decision: 'commit'; next: Omit<RolloutFlag, 'changedAt'> }
  | { decision: 'noop'; reason: string }   // already in the target end-state by THIS rollout (safe retry)
  | { decision: 'refuse'; reason: string };

function wellFormed(v: unknown): v is RolloutFlag {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as RolloutFlag).paused === 'boolean';
}

function baseNext(intent: TransitionIntent, paused: boolean, state: FlagState): Omit<RolloutFlag, 'changedAt'> {
  return { paused, state, rolloutId: intent.rolloutId, reviewedSha: intent.reviewedSha, changedBy: intent.changedBy, reason: intent.reason };
}

/**
 * Pure CAS decision. `current` is the value observed INSIDE the transaction
 * (null = absent). Only these transitions are allowed:
 *   CLOSE : absent | OPEN            → CLOSED (this rollout's id + sha)
 *   REOPEN: CLOSED by THIS rollout   → OPEN
 * Everything else refuses. A retry that finds the flag already in the target
 * end-state for THIS rollout returns `noop` (idempotent success, no re-write).
 */
export function decideFlagTransition(current: unknown, intent: TransitionIntent): TransitionDecision {
  if (!intent.rolloutId || !intent.reviewedSha) return { decision: 'refuse', reason: 'intent_missing_rollout_or_sha' };
  // A present-but-malformed flag is always unexpected — never overwrite blindly.
  if (current !== null && current !== undefined && !wellFormed(current)) {
    return { decision: 'refuse', reason: 'malformed_prior_value' };
  }
  const cur = (current ?? null) as RolloutFlag | null;

  if (intent.op === 'close') {
    if (cur === null || cur.paused === false) {
      return { decision: 'commit', next: baseNext(intent, true, 'CLOSED') };
    }
    // cur.paused === true (already closed)
    if (cur.rolloutId === intent.rolloutId && cur.reviewedSha === intent.reviewedSha) {
      return { decision: 'noop', reason: 'already_closed_by_this_rollout' };
    }
    return { decision: 'refuse', reason: cur.rolloutId !== intent.rolloutId ? 'closed_by_other_rollout' : 'closed_under_other_sha' };
  }

  // reopen
  if (cur === null || cur.paused === false) {
    if (cur && cur.rolloutId === intent.rolloutId && cur.reviewedSha === intent.reviewedSha) {
      return { decision: 'noop', reason: 'already_open_by_this_rollout' };
    }
    return { decision: 'refuse', reason: 'not_closed' };
  }
  // cur.paused === true (closed) — reopen only if same rollout AND same sha
  if (cur.rolloutId !== intent.rolloutId) return { decision: 'refuse', reason: 'reopen_other_rollout' };
  if (cur.reviewedSha !== intent.reviewedSha) return { decision: 'refuse', reason: 'reopen_sha_mismatch' };
  return { decision: 'commit', next: baseNext(intent, false, 'OPEN') };
}
