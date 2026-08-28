// chronoCommitCoordinator.ts — the ONE serialized, atomic canonical-mutation
// coordinator. Per-node fence CAS (wellFence) prevents a lower fence from
// overwriting a node, but is NOT multi-node atomic; a canonical mutation
// (processed + neighbors + AFR + outgoing + wellStatus + performance +
// production + review + revision + receipt) must land as ONE atomic
// multi-location update or not at all.
//
// Model (pure/injected — unit-tested with a controlled clock; the RTDB
// integration supplies the lock CAS + the single db.ref().update()):
//   1. Acquire the per-well lock in `planning` (token+fence).
//   2. Load + compute the COMPLETE patch (incl. the completion receipt).
//   3. CAS the lock `planning → committing`, verifying the same token+fence.
//      Once `committing`, ordinary TTL takeover is forbidden until a horizon
//      GREATER than the function's hard max lifetime (60s v1 default) + margin.
//   4. Submit ONE atomic multi-location update = the whole patch + the receipt.
//   5. Release the lock. If release fails, a later worker (past the horizon)
//      reads the receipt and releases idempotently WITHOUT recomputation.
//
// Crash recovery (only past the horizon):
//   receipt present → the atomic commit succeeded → release/complete idempotently;
//   receipt absent  → the atomic commit did NOT occur → clear + requeue the SAME
//                     operationId (never mint a replacement); the recomputed retry
//                     is idempotent because a real commit would have written the
//                     receipt.

export type LockPhase = 'planning' | 'committing';

export interface LockRecord {
  token: string;
  fence: number;
  phase: LockPhase;
  at: number;           // ms when this phase was entered
  operationId: string;
}

export interface CommitReceipt {
  operationId: string;
  mutationType: 'create' | 'backdated_create' | 'edit' | 'delete';
  wellName: string;
  fence: number;
  revision: number;
  affectedPacketIds: string[];
  committedAtMs: number;
  patchHash: string;
}

export interface CoordinatorTimeouts {
  /** Function hard max lifetime (v1 default 60s). */
  functionMaxMs: number;
  /** Extra safety margin beyond functionMaxMs before a committing lock is recoverable. */
  recoveryMarginMs: number;
  /** Planning-phase lease (a planning holder that vanishes frees the well by TTL). */
  planningLeaseMs: number;
}

export const DEFAULT_TIMEOUTS: CoordinatorTimeouts = {
  functionMaxMs: 60_000,      // processIncomingPull v1 default (confirmed: no runWith override)
  recoveryMarginMs: 60_000,
  planningLeaseMs: 30_000,
};

/** committing locks are recoverable only after functionMaxMs + margin. */
export function commitHorizonMs(t: CoordinatorTimeouts): number {
  return t.functionMaxMs + t.recoveryMarginMs;
}

export type LockDecision =
  | { kind: 'acquire'; next: LockRecord }
  | { kind: 'contended'; reason: 'planning_held' | 'committing_in_flight' }
  | { kind: 'recover'; stuck: LockRecord };  // committing, past horizon → inspect receipt

/**
 * Decide what a worker may do given the current lock. A `committing` lock within
 * the horizon is NEVER taken over (the holder may still be executing). A
 * `planning` lock is taken over only after its lease. Past the horizon a
 * committing lock is handed to recovery (which consults the receipt).
 */
export function planLockAcquire(
  cur: LockRecord | null | undefined,
  token: string,
  now: number,
  t: CoordinatorTimeouts,
  operationId: string,
): LockDecision {
  if (!cur) {
    return { kind: 'acquire', next: { token, fence: 1, phase: 'planning', at: now, operationId } };
  }
  if (cur.phase === 'committing') {
    if (now - cur.at < commitHorizonMs(t)) return { kind: 'contended', reason: 'committing_in_flight' };
    return { kind: 'recover', stuck: cur };
  }
  // planning: takeover only after the planning lease.
  if (now - cur.at < t.planningLeaseMs && cur.token !== token) {
    return { kind: 'contended', reason: 'planning_held' };
  }
  return { kind: 'acquire', next: { token, fence: cur.fence + 1, phase: 'planning', at: now, operationId } };
}

/** Transition planning → committing, only if the lock is still ours (same
 *  token+fence). Once committing, TTL takeover is blocked until the horizon. */
export function planTransitionToCommitting(
  cur: LockRecord | null | undefined,
  token: string,
  fence: number,
  now: number,
): LockRecord | undefined {
  if (cur && cur.token === token && cur.fence === fence && cur.phase === 'planning') {
    return { ...cur, phase: 'committing', at: now };
  }
  return undefined; // abort — we lost ownership; must NOT commit
}

/** Release only if the committing lock is still ours. */
export function planReleaseCommitting(cur: LockRecord | null | undefined, token: string, fence: number): LockRecord | null | undefined {
  if (cur && cur.token === token && cur.fence === fence) return null; // clear
  return cur; // leave a newer owner's record intact
}

// ── Orchestrator (injected IO) ─────────────────────────────────────────────

export interface CoordinatorIO {
  now(): number;
  newToken(): string;
  /** Read the well lock node. */
  readLock(wellName: string): Promise<LockRecord | null>;
  /** Compare-and-set the lock node atomically (transaction). Returns the value
   *  actually stored (so the caller learns its fence) or 'lost' on CAS failure. */
  casLock(wellName: string, apply: (cur: LockRecord | null) => LockRecord | null | undefined): Promise<{ ok: true; value: LockRecord | null } | { ok: false }>;
  /** Read a completion receipt by operation id. */
  readReceipt(wellName: string, operationId: string): Promise<CommitReceipt | null>;
  /** ONE atomic multi-location update — the whole canonical patch INCLUDING the
   *  receipt. All-or-nothing. */
  commitAtomic(patch: Record<string, unknown>): Promise<void>;
}

export type MutationOutcome =
  | { status: 'committed'; receipt: CommitReceipt }
  | { status: 'already_done'; receipt: CommitReceipt }   // receipt already present (idempotent)
  | { status: 'recovered_released' }                     // stuck-but-committed → released
  | { status: 'recovered_requeue'; operationId: string } // stuck-not-committed → cleared, requeue same id
  | { status: 'contended'; reason: string }
  | { status: 'lost_ownership' }                         // could not enter committing
  | { status: 'commit_failed' };

export interface MutationRequest {
  wellName: string;
  operationId: string;
  /** Build the complete patch + receipt given the acquired fence/revision. */
  buildPatch: (ctx: { fence: number; token: string }) => Promise<{ patch: Record<string, unknown>; receipt: CommitReceipt }>;
}

export async function runCanonicalMutation(
  io: CoordinatorIO,
  req: MutationRequest,
  t: CoordinatorTimeouts = DEFAULT_TIMEOUTS,
): Promise<MutationOutcome> {
  // Idempotency: if this operation already has a receipt, it is done.
  const existing = await io.readReceipt(req.wellName, req.operationId);
  if (existing) return { status: 'already_done', receipt: existing };

  const token = io.newToken();

  // 1. Acquire planning (handling recovery of a stuck committing lock).
  const cur0 = await io.readLock(req.wellName);
  const decision = planLockAcquire(cur0, token, io.now(), t, req.operationId);

  if (decision.kind === 'contended') return { status: 'contended', reason: decision.reason };

  if (decision.kind === 'recover') {
    // A committing lock is past the horizon → its holder is dead. Consult the
    // receipt of the STUCK operation to decide.
    const stuckReceipt = await io.readReceipt(req.wellName, decision.stuck.operationId);
    if (stuckReceipt) {
      // The atomic commit succeeded before the crash → just release.
      await io.casLock(req.wellName, (c) => planReleaseCommitting(c, decision.stuck.token, decision.stuck.fence) ?? null);
      return { status: 'recovered_released' };
    }
    // No receipt → the atomic commit did NOT occur. Clear the lock and requeue
    // the SAME operationId (never mint a replacement). A resumed earlier worker
    // cannot commit: it would fail planTransitionToCommitting (its fence is gone).
    await io.casLock(req.wellName, (c) => (c && c.token === decision.stuck.token ? null : c));
    return { status: 'recovered_requeue', operationId: decision.stuck.operationId };
  }

  // Acquire the planning lock via CAS (must match what we read).
  const acq = await io.casLock(req.wellName, (c) => {
    const d = planLockAcquire(c, token, io.now(), t, req.operationId);
    return d.kind === 'acquire' ? d.next : undefined; // abort on any change
  });
  if (!acq.ok || !acq.value) return { status: 'contended', reason: 'acquire_race' };
  const myFence = acq.value.fence;

  // 2. Load + compute the COMPLETE patch (+ receipt).
  const { patch, receipt } = await req.buildPatch({ fence: myFence, token });

  // 3. Transition planning → committing (verify same token+fence). Once here,
  //    no TTL takeover until the horizon.
  const trans = await io.casLock(req.wellName, (c) => planTransitionToCommitting(c, token, myFence, io.now()));
  if (!trans.ok) return { status: 'lost_ownership' };

  // 4. ONE atomic multi-location update = whole patch + receipt (all-or-nothing).
  try {
    await io.commitAtomic(patch);
  } catch {
    // The atomic update exposes NONE of the patch. Leave the lock committing; a
    // recovery past the horizon sees no receipt and requeues the same op id.
    return { status: 'commit_failed' };
  }

  // 5. Release.
  await io.casLock(req.wellName, (c) => planReleaseCommitting(c, token, myFence) ?? null);
  return { status: 'committed', receipt };
}
