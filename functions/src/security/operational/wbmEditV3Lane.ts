/**
 * WB-M ordinary-edit DURABLE LANE (v3) — PURE lifecycle state machine.
 *
 * WHY THIS EXISTS
 * The legacy ordinary edit route (`ingestWbmEdit` → `packets/incoming/{id}` →
 * `applyV2ChronologicalEdit`) can consume an accepted edit and leave ZERO durable
 * trace: the per-well coordinator dedupes on `wells/{well}/chronoReceipts/{id}` —
 * a DIFFERENT subtree from the trail (`packets/editHistory|editReceipts` +
 * `packets/processed`) — and skips the whole `buildPatch` (which is the only
 * writer of that trail) whenever a receipt exists, deleting `incoming` and
 * writing nothing. Acceptance therefore never durably guarantees application.
 *
 * THE V3 CONTRACT
 * A dedicated, additive, edit-only lane in its OWN server namespace
 * (`wbmEdits/v3/ops/{editEventId}`) that:
 *   - acknowledges acceptance ONLY after the op is durably stored;
 *   - is idempotent on the OP RECORD itself (same id + same digest resumes the
 *     existing op; same id + different digest is a permanent idempotency conflict);
 *   - drives a strict lifecycle accepted → applying → (applied | rejected |
 *     retry_wait) with a dedicated worker and a bounded reconciler;
 *   - VERIFIES the durable trail actually landed before declaring `applied`, so
 *     the receipt-vs-trail asymmetry that loses legacy edits can never silently
 *     lose a v3 edit — an unverifiable apply becomes retry_wait, then a durable
 *     `rejected` with reason, never a zero-trace vanish;
 *   - NEVER routes through, or falls back to, the broken `packets/incoming` edit
 *     path.
 *
 * This module is PURE (no Firebase, no I/O, no clock). Every decision is a
 * function of (current op, inputs, nowMs) so the full lifecycle is unit-testable
 * and deterministic. The index.ts callable/trigger/scheduler are thin adapters
 * that read/write RTDB and inject `nowMs`.
 */

export type WbmEditV3Status = 'accepted' | 'applying' | 'applied' | 'rejected' | 'retry_wait';

/** The single durable operation record. Its presence + status IS the source of truth. */
export interface WbmEditV3Op {
  editEventId: string;
  originalPacketId: string;
  wellName: string;
  companyId: string;
  driverId: string;
  /** Server-computed canonical digest of the normalized edit payload. */
  digest: string;
  /** Deterministic changed-only field mask (from the client, re-validated server-side). */
  editedFields: string[];
  /** The normalized edit payload (the exact values to apply). */
  payload: Record<string, unknown>;
  status: WbmEditV3Status;
  acceptedAt: number;
  claimedAt: number | null;
  appliedAt: number | null;
  rejectedAt: number | null;
  retryWaitUntil: number | null;
  /** Number of APPLY attempts (not submit attempts). */
  attempts: number;
  lastError: string | null;
  rejectReason: string | null;
  /** True only once the durable trail (editHistory/{orig}/{id}) is read back present. */
  trailVerified: boolean;
  /** Immutable before→after captured at application time (for History display). */
  beforeAfter: unknown;
  updatedAt: number;
}

export const WBM_EDIT_V3_ROOT = 'wbmEdits/v3';
export const WBM_EDIT_V3_OPS_PATH = `${WBM_EDIT_V3_ROOT}/ops`;
export function wbmEditV3OpPath(editEventId: string): string {
  return `${WBM_EDIT_V3_OPS_PATH}/${editEventId}`;
}

/** Bounded retry policy. Exhausting attempts yields a durable `rejected`, never a silent drop. */
export const V3_MAX_APPLY_ATTEMPTS = 5;
/** A claim older than this is presumed dead (worker crashed mid-apply) and reclaimable. */
export const V3_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
/** Exponential-ish backoff per attempt; last value repeats. */
export const V3_RETRY_BACKOFF_MS = [15_000, 60_000, 300_000, 900_000, 3_600_000];

// ---------------------------------------------------------------------------
// SUBMIT (callable): idempotent acceptance on the op record.
// ---------------------------------------------------------------------------

export interface SubmitIncoming {
  editEventId: string;
  originalPacketId: string;
  wellName: string;
  companyId: string;
  driverId: string;
  digest: string;
  editedFields: string[];
  payload: Record<string, unknown>;
}

export interface SubmitResponse {
  ok: boolean;
  status: WbmEditV3Status;
  editEventId: string;
  idempotent?: boolean;
  reason?: string;
}

export type SubmitDecision =
  | { action: 'create'; op: WbmEditV3Op; response: SubmitResponse }
  | { action: 'resume'; response: SubmitResponse }
  | { action: 'reject_conflict'; response: SubmitResponse };

/**
 * Decide what a submit does against the CURRENT stored op (read inside the same
 * transaction that will apply the returned mutation). Acceptance is acknowledged
 * ONLY when the caller commits the `create` op — never before durable storage.
 */
export function decideSubmit(input: {
  existing: WbmEditV3Op | null;
  incoming: SubmitIncoming;
  nowMs: number;
}): SubmitDecision {
  const { existing, incoming, nowMs } = input;

  if (!existing) {
    const op: WbmEditV3Op = {
      editEventId: incoming.editEventId,
      originalPacketId: incoming.originalPacketId,
      wellName: incoming.wellName,
      companyId: incoming.companyId,
      driverId: incoming.driverId,
      digest: incoming.digest,
      editedFields: incoming.editedFields,
      payload: incoming.payload,
      status: 'accepted',
      acceptedAt: nowMs,
      claimedAt: null,
      appliedAt: null,
      rejectedAt: null,
      retryWaitUntil: null,
      attempts: 0,
      lastError: null,
      rejectReason: null,
      trailVerified: false,
      beforeAfter: null,
      updatedAt: nowMs,
    };
    return {
      action: 'create',
      op,
      response: { ok: true, status: 'accepted', editEventId: incoming.editEventId },
    };
  }

  // Same editEventId already exists — dedupe on the digest.
  if (existing.digest === incoming.digest) {
    // Same logical edit: resume/return the existing durable status. A double
    // Save (or a retry) NEVER creates a second operation and NEVER re-accepts a
    // terminal/in-flight op.
    return {
      action: 'resume',
      response: {
        ok: true,
        status: existing.status,
        editEventId: existing.editEventId,
        idempotent: true,
      },
    };
  }

  // Same id, DIFFERENT payload → permanent idempotency conflict. The existing op
  // is left untouched; the caller must mint a new editEventId for a new edit.
  return {
    action: 'reject_conflict',
    response: {
      ok: false,
      status: existing.status,
      editEventId: existing.editEventId,
      reason: 'idempotency_conflict',
    },
  };
}

// ---------------------------------------------------------------------------
// CLAIM (worker): accepted | due-retry_wait | dead-applying → applying.
// ---------------------------------------------------------------------------

export type ClaimDecision =
  | { claim: true; next: WbmEditV3Op }
  | { claim: false; reason: 'missing' | 'already_terminal' | 'inflight_fresh' | 'retry_not_due' };

/** Single-claim transition guard. Only one worker may move an op into `applying`. */
export function decideClaim(op: WbmEditV3Op | null, nowMs: number): ClaimDecision {
  if (!op) return { claim: false, reason: 'missing' };
  if (op.status === 'applied' || op.status === 'rejected') {
    return { claim: false, reason: 'already_terminal' };
  }
  if (op.status === 'accepted') {
    return { claim: true, next: { ...op, status: 'applying', claimedAt: nowMs, updatedAt: nowMs } };
  }
  if (op.status === 'retry_wait') {
    if ((op.retryWaitUntil ?? 0) > nowMs) return { claim: false, reason: 'retry_not_due' };
    return { claim: true, next: { ...op, status: 'applying', claimedAt: nowMs, updatedAt: nowMs } };
  }
  // status === 'applying': reclaim only if the prior claim is presumed dead.
  if (nowMs - (op.claimedAt ?? 0) > V3_CLAIM_TIMEOUT_MS) {
    return { claim: true, next: { ...op, status: 'applying', claimedAt: nowMs, updatedAt: nowMs } };
  }
  return { claim: false, reason: 'inflight_fresh' };
}

// ---------------------------------------------------------------------------
// APPLY OUTCOME (worker): resolve an `applying` op after the apply + trail read.
// ---------------------------------------------------------------------------

export interface ApplyOutcomeInput {
  op: WbmEditV3Op; // must be in `applying`
  /** packets/editHistory/{originalPacketId}/{editEventId} exists after the apply. */
  trailVerified: boolean;
  /** null when the apply itself threw no error. */
  error: string | null;
  /** true when `error` is a validation/authority failure (never retry). */
  permanent: boolean;
  beforeAfter?: unknown;
  nowMs: number;
}

/**
 * The load-bearing safety rule: an op becomes `applied` ONLY when the apply
 * returned no error AND the durable trail was verified present. An apply that
 * "succeeded" but left no trail (the legacy already-done-without-trail
 * pathology) is treated as a transient failure → retry_wait → eventually a
 * durable `rejected` (reason `max_retries:trail_verification_failed`). It is
 * never silently marked applied and never vanishes.
 */
export function decideApplyOutcome(i: ApplyOutcomeInput): WbmEditV3Op {
  const attempts = i.op.attempts + 1;

  if (i.error && i.permanent) {
    return {
      ...i.op,
      status: 'rejected',
      attempts,
      rejectedAt: i.nowMs,
      lastError: i.error,
      rejectReason: i.error,
      updatedAt: i.nowMs,
    };
  }

  if (!i.error && i.trailVerified) {
    return {
      ...i.op,
      status: 'applied',
      attempts,
      appliedAt: i.nowMs,
      trailVerified: true,
      beforeAfter: i.beforeAfter ?? i.op.beforeAfter ?? null,
      lastError: null,
      rejectReason: null,
      updatedAt: i.nowMs,
    };
  }

  // Transient apply error OR apply-without-trail. Bounded retry, then durable reject.
  const reason = i.error ?? 'trail_verification_failed';
  if (attempts >= V3_MAX_APPLY_ATTEMPTS) {
    return {
      ...i.op,
      status: 'rejected',
      attempts,
      rejectedAt: i.nowMs,
      lastError: reason,
      rejectReason: `max_retries:${reason}`,
      updatedAt: i.nowMs,
    };
  }
  const backoff = V3_RETRY_BACKOFF_MS[Math.min(attempts - 1, V3_RETRY_BACKOFF_MS.length - 1)];
  return {
    ...i.op,
    status: 'retry_wait',
    attempts,
    retryWaitUntil: i.nowMs + backoff,
    lastError: reason,
    updatedAt: i.nowMs,
  };
}

// ---------------------------------------------------------------------------
// RECONCILE (scheduled, bounded): re-drive stuck/overdue ops, never drop.
// ---------------------------------------------------------------------------

export type ReconcileAction = 'redrive' | 'skip' | 'reject_exhausted';

/**
 * Bounded reconciler decision. `redrive` re-invokes the worker's claim→apply
 * path; `reject_exhausted` durably rejects an op that has burned its attempts;
 * `skip` leaves fresh/terminal ops alone.
 */
export function decideReconcile(op: WbmEditV3Op, nowMs: number): ReconcileAction {
  if (op.status === 'applied' || op.status === 'rejected') return 'skip';
  if (op.status === 'accepted') return 'redrive'; // worker onCreate never fired / was missed
  if (op.status === 'applying') {
    return nowMs - (op.claimedAt ?? 0) > V3_CLAIM_TIMEOUT_MS ? 'redrive' : 'skip';
  }
  // retry_wait
  if ((op.retryWaitUntil ?? 0) > nowMs) return 'skip';
  if (op.attempts >= V3_MAX_APPLY_ATTEMPTS) return 'reject_exhausted';
  return 'redrive';
}

/** Build the terminal rejected op for an exhausted reconcile target. */
export function rejectExhausted(op: WbmEditV3Op, nowMs: number): WbmEditV3Op {
  const reason = op.lastError ?? 'unknown';
  return {
    ...op,
    status: 'rejected',
    rejectedAt: nowMs,
    rejectReason: `max_retries:${reason}`,
    updatedAt: nowMs,
  };
}
