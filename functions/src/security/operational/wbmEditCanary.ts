/**
 * Additive, kill-switch-gated WB-M edit canary + governed edit-status logic.
 *
 * PURPOSE: recover the ONE preserved Test Well edit that the currently-deployed
 * (drifted) edit pipeline accepted as `pending` then lost, WITHOUT touching the
 * behavior of any deployed global handler. These are pure decision functions;
 * the thin callables live in index.ts (where applyV2ChronologicalEdit is) and
 * apply the edit ONLY when the gate below explicitly allows it.
 *
 * BEHAVIOR-NEUTRALITY CONTRACT (proven in wbmEditCanary.test.ts):
 *   • The gate is CLOSED unless BOTH the master switch is on AND the exact
 *     editEventId is allow-listed AND its wellName + originalPacketId match.
 *   • A missing/empty flag node ⇒ gate CLOSED ⇒ the recovery callable is a
 *     no-op refusal ⇒ deploying it changes nothing for any well/company.
 *   • No well name, company, or driver is ever inferred — everything is exact.
 */

/** RTDB path of the kill switch. Absent node ⇒ everything OFF. */
export const WBM_EDIT_CANARY_FLAG_PATH = 'flags/wbmEditCanary';

/** Shape of flags/wbmEditCanary (all fields optional; absent ⇒ off):
 *  {
 *    enabled: true,                          // master switch
 *    allow: { "<editEventId>": { wellName, originalPacketId } }
 *  }
 */
export type CanaryFlag = {
  enabled?: unknown;
  allow?: Record<string, { wellName?: unknown; originalPacketId?: unknown } | undefined>;
} | null | undefined;

export type CanaryGateInput = {
  flag: CanaryFlag;
  editEventId: string;
  wellName: string;
  originalPacketId: string;
};

export type CanaryGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The ONLY place that says "yes, apply this edit outside the normal pipeline".
 * Fail-closed on every ambiguity. Requires exact editEventId + wellName +
 * originalPacketId agreement with the allow-list entry.
 */
export function evaluateCanaryGate(input: CanaryGateInput): CanaryGateResult {
  const { flag, editEventId, wellName, originalPacketId } = input;
  if (!flag || typeof flag !== 'object') return { allowed: false, reason: 'canary_flag_absent' };
  if (flag.enabled !== true) return { allowed: false, reason: 'canary_master_disabled' };
  const allow = flag.allow;
  if (!allow || typeof allow !== 'object') return { allowed: false, reason: 'canary_allowlist_empty' };
  if (!editEventId) return { allowed: false, reason: 'edit_event_id_required' };
  const entry = allow[editEventId];
  if (!entry || typeof entry !== 'object') return { allowed: false, reason: 'edit_event_id_not_allowlisted' };
  if (typeof entry.wellName !== 'string' || entry.wellName !== wellName) {
    return { allowed: false, reason: 'canary_well_mismatch' };
  }
  if (typeof entry.originalPacketId !== 'string' || entry.originalPacketId !== originalPacketId) {
    return { allowed: false, reason: 'canary_original_mismatch' };
  }
  return { allowed: true };
}

// ─────────────────────── governed edit-status classification ───────────────────────

export type WbmEditStatus = 'pending' | 'applied' | 'rejected' | 'missing';

export type EditStatusInputs = {
  /** packets/editReceipts/{editEventId} value, or null. */
  receipt: Record<string, unknown> | null;
  /** The original processed packet, or null. */
  original: Record<string, unknown> | null;
  /** packets/rejected/{editEventId} value, or null. */
  rejected: Record<string, unknown> | null;
  /** packets/incoming/{editEventId} value, or null. */
  incoming: Record<string, unknown> | null;
  /** This correction's event id — used to confirm application on the original. */
  editEventId: string;
};

/**
 * Classify the governed lifecycle of ONE correction from server truth only.
 * Precedence: applied (a durable receipt or the original carries THIS event's
 * correction) > rejected (a durable quarantine) > pending (still queued) >
 * missing (no trace anywhere — the drifted-pipeline loss case).
 */
export function classifyEditStatus(inputs: EditStatusInputs): WbmEditStatus {
  const { receipt, original, rejected, incoming, editEventId } = inputs;
  if (receipt && typeof receipt === 'object') return 'applied';
  if (originalCarriesEdit(original, editEventId)) return 'applied';
  if (rejected && typeof rejected === 'object') return 'rejected';
  if (incoming && typeof incoming === 'object') return 'pending';
  return 'missing';
}

/** True when the original processed packet already records THIS edit event
 *  (via editCorrections/{editEventId} or an editEventId/editedByEventId stamp). */
export function originalCarriesEdit(original: Record<string, unknown> | null, editEventId: string): boolean {
  if (!original || typeof original !== 'object' || !editEventId) return false;
  const corr = original.editCorrections;
  if (corr && typeof corr === 'object' && Object.prototype.hasOwnProperty.call(corr, editEventId)) return true;
  if (original.editEventId === editEventId) return true;
  if (original.editedByEventId === editEventId) return true;
  const applied = original.appliedEditEventIds;
  if (applied && typeof applied === 'object' && Object.prototype.hasOwnProperty.call(applied, editEventId)) return true;
  return false;
}

/**
 * Recovery pre-condition from server truth. Recovery is permitted ONLY when the
 * edit is genuinely missing (accepted-then-lost) — never when it is already
 * applied/rejected/pending, and never when a prior recovery claim exists.
 */
export type RecoveryPrecondition =
  | { proceed: true }
  | { proceed: false; status: WbmEditStatus | 'claimed'; reason: string };

export function evaluateRecoveryPrecondition(inputs: EditStatusInputs & {
  recoveryClaim: Record<string, unknown> | null;
}): RecoveryPrecondition {
  const status = classifyEditStatus(inputs);
  if (status === 'applied') return { proceed: false, status, reason: 'already_applied' };
  if (status === 'rejected') return { proceed: false, status, reason: 'already_rejected' };
  if (status === 'pending') return { proceed: false, status, reason: 'still_pending_in_incoming' };
  if (inputs.recoveryClaim && typeof inputs.recoveryClaim === 'object') {
    return { proceed: false, status: 'claimed', reason: 'recovery_already_claimed' };
  }
  return { proceed: true };
}

// ─────────────────────── testable recovery orchestration ───────────────────────
// Injected IO so the full gate → precondition → single-claim → apply → verify
// flow is provable against a fake RTDB with NO emulator and NO index.ts import.

export type RecoveryIO = {
  /** flags/wbmEditCanary value (null if absent). */
  readFlag: () => Promise<CanaryFlag>;
  readReceipt: () => Promise<Record<string, unknown> | null>;
  readRejected: () => Promise<Record<string, unknown> | null>;
  readIncoming: () => Promise<Record<string, unknown> | null>;
  /** Atomic single-claim. Resolves true iff THIS call won the claim. */
  claim: () => Promise<boolean>;
  /** Apply the correction through the canonical applier. */
  apply: () => Promise<void>;
  /** editReceipts/{editEventId} after apply — proves the terminal record exists. */
  readReceiptAfterApply: () => Promise<Record<string, unknown> | null>;
};

export type RecoveryOutcome =
  | { ok: true; status: 'applied'; receiptWritten: boolean }
  | { ok: true; status: WbmEditStatus | 'claimed'; reason: string; idempotent: true }
  | { ok: false; status: 'refused'; reason: string };

/**
 * Orchestrate a governed recovery from an ALREADY-authorized correction (the
 * caller must have validated ownership/company via evaluateWbmEdit). Fail-closed
 * on the gate; idempotent on repeat; applies exactly once; never leaves the edit
 * without a terminal record.
 */
export async function orchestrateGovernedRecovery(input: {
  editEventId: string;
  wellName: string;
  originalPacketId: string;
  original: Record<string, unknown> | null;
  io: RecoveryIO;
}): Promise<RecoveryOutcome> {
  const { editEventId, wellName, originalPacketId, original, io } = input;
  const flag = await io.readFlag();
  const gate = evaluateCanaryGate({ flag, editEventId, wellName, originalPacketId });
  if (!gate.allowed) return { ok: false, status: 'refused', reason: `canary_disabled:${gate.reason}` };

  const [receipt, rejected, incoming] = await Promise.all([
    io.readReceipt(), io.readRejected(), io.readIncoming(),
  ]);
  const pre = evaluateRecoveryPrecondition({
    receipt, original, rejected, incoming, editEventId, recoveryClaim: null,
  });
  if (!pre.proceed) return { ok: true, status: pre.status, reason: pre.reason, idempotent: true };

  const won = await io.claim();
  if (!won) return { ok: true, status: 'claimed', reason: 'recovery_already_claimed', idempotent: true };

  await io.apply();
  const after = await io.readReceiptAfterApply();
  return { ok: true, status: 'applied', receiptWritten: !!after };
}
