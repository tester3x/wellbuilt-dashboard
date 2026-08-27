// recoverRejectedPull.ts — governed, company-scoped recovery of a pull that
// was losslessly quarantined to packets/rejected for the ONE recoverable
// condition (STALE_PULL_TIME from an AM/PM entry mistake — Gabriel 5,
// 8/27/2026). Mechanism A: submit ONE corrected replacement pull with a NEW
// stable packet id, processed by the CANONICAL processor (processIncomingPull),
// carrying provenance back to the rejected original — then mark the rejected
// record recovered ONLY after the replacement has an authoritative processed
// receipt.
//
// PURE + injected (no firebase-admin / firebase-functions import) so both the
// decision ladder (planRecovery) AND the operational runner (executeRecovery)
// unit-test without an emulator, exactly like packetGuards.ts. The thin
// authenticated onCall wrapper (recoverRejectedPullCallable.ts) supplies the
// real transactional read/write/claim surface.
//
// Invariants:
//  - The original rejected `.packet` payload is NEVER deleted or altered — only
//    SIBLING keys (recoveryClaim, recoveredByPacketId, recoveredAt, …).
//  - Only requestType 'pull' rejected for exactly STALE_PULL_TIME is eligible.
//  - Every immutable/source field (company, driver, well, timezone, requestType)
//    comes from the preserved server record, never from caller-supplied data.
//  - dateTimeUTC is the single source of truth for time; the local display
//    string is DERIVED from it + the record's timezone (never trusted from two
//    independent inputs).
//  - Single-winner: one atomic claim per rejected id → at most one replacement
//    id can ever enter processing; a different id after a claim is a conflict.
//  - No physical-plausibility gate: recovery is authorized by driver-confirmed
//    intent, never rejected on physical inference.

/** The ONLY rejection code this callable may revive in this version. */
export const RECOVERABLE_REJECTION_REASON = 'STALE_PULL_TIME';

const MAX_KEY_LEN = 256;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_PATH = /[.#$/[\]\x00-\x1f\x7f]/;

/** A firebase key: non-empty, <=256, no . # $ / [ ] and no control chars, and
 *  no leading/trailing whitespace (a path-changing or unsafe key is rejected). */
export function isValidPacketKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_KEY_LEN &&
    value === value.trim() &&
    !CONTROL_OR_PATH.test(value)
  );
}
export { isValidPacketKey as isFirebaseKeySafe };

/** Canonical WB-M packet id: <YYYYMMDD>_<HHMMSS>_<well>_<suffix>. */
export function isCanonicalPacketId(value: unknown): value is string {
  return isValidPacketKey(value) && /^\d{8}_\d{6}_.+$/.test(value as string);
}

/**
 * Derive the local display time from the authoritative UTC instant + timezone.
 * Time has ONE source of truth (dateTimeUTC); the display string is never
 * accepted as an independent second input. Returns '' when unparseable.
 */
export function deriveLocalDateTime(dateTimeUTC: string, timezone?: string): string {
  const d = new Date(dateTimeUTC);
  if (!Number.isFinite(d.getTime())) return '';
  const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d);
    return parts.replace(',', '');
  } catch {
    return '';
  }
}

export interface CorrectedPullFields {
  dateTimeUTC: string;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown: boolean;
}

export interface RecoveryInput {
  rejectedPacketId: string;
  replacementPacketId: string;
  corrected: CorrectedPullFields;
  caller: { companyId?: string; driverId: string };
}

export interface RejectedRecord {
  packetId?: string;
  packet?: Record<string, unknown>;
  wellName?: string;
  requestType?: string;
  reason?: string;
  recoveredByPacketId?: string;
  recoveredAt?: string;
  recoveryStatus?: string;
  /** Single-recovery claim (sibling of .packet), set by an atomic transaction. */
  recoveryClaim?: { replacementPacketId?: string; claimedAt?: unknown } | null;
}

export interface RecoveryState {
  rejected: RejectedRecord | null;                       // packets/rejected/<rejectedId>
  replacementProcessed: Record<string, unknown> | null;  // packets/processed/<replacementId>
  /** Whether packets/incoming/<replacementId> currently exists (in flight). */
  replacementIncoming: boolean;
  /** packets/rejected/<replacementId> — the processor rejected the replacement. */
  replacementRejected: Record<string, unknown> | null;
  watermarkDateTimeUTC: string | null;
  nowMs: number;
}

export type RecoveryRejectCode =
  | 'INVALID_ARGUMENT'
  | 'REJECTED_RECORD_NOT_FOUND'
  | 'REJECTION_NOT_RECOVERABLE'
  | 'NOT_A_PULL'
  | 'CROSS_COMPANY'
  | 'NOT_OWNER'
  | 'WELL_MISMATCH'
  | 'MALFORMED_REPLACEMENT_TIME'
  | 'REPLACEMENT_NOT_NEWER'
  | 'REPLACEMENT_ID_CONFLICT'
  | 'REPLACEMENT_REJECTED'
  | 'RECOVERED_UNDER_DIFFERENT_ID';

export type RecoveryPlan =
  | { action: 'reject'; code: RecoveryRejectCode; message: string }
  | { action: 'noop_complete'; code: 'ALREADY_RECOVERED'; replacementPacketId: string }
  | { action: 'annotate_only'; code: 'PROCESSED_AWAIT_ANNOTATION'; replacementPacketId: string }
  | { action: 'already_in_flight'; code: 'REPLACEMENT_IN_INCOMING'; replacementPacketId: string }
  | { action: 'process'; code: 'SUBMIT_REPLACEMENT'; incomingPath: string };

const norm = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/**
 * Pure decision from the current server state. Order: argument shape →
 * existence → eligibility (STALE_PULL_TIME only) → pull → ownership → idempotency
 * by processed receipt → replacement rejected by processor → in-flight →
 * watermark preflight → process.
 */
export function planRecovery(input: RecoveryInput, state: RecoveryState): RecoveryPlan {
  const rejectedId = norm(input?.rejectedPacketId);
  const replacementId = norm(input?.replacementPacketId);

  // 0. Argument shape + key safety.
  if (!rejectedId || !replacementId) {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'rejectedPacketId and replacementPacketId are required' };
  }
  if (!isValidPacketKey(rejectedId) || !isValidPacketKey(replacementId)) {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'packet ids must be valid firebase keys (no . # $ / [ ] / control chars, <=256)' };
  }
  if (!isCanonicalPacketId(replacementId)) {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'replacementPacketId must be canonical <YYYYMMDD>_<HHMMSS>_<well>_<suffix>' };
  }
  if (replacementId === rejectedId) {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'replacementPacketId must differ from rejectedPacketId (a new stable identity)' };
  }
  const corrected = input.corrected;
  if (!corrected || !norm(corrected.dateTimeUTC)
      || typeof corrected.tankLevelFeet !== 'number' || !Number.isFinite(corrected.tankLevelFeet)
      || typeof corrected.bblsTaken !== 'number' || !Number.isFinite(corrected.bblsTaken)
      || typeof corrected.wellDown !== 'boolean') {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'corrected {dateTimeUTC, tankLevelFeet, bblsTaken, wellDown} required and well-typed' };
  }

  // 1. Existence.
  if (!state.rejected) {
    return { action: 'reject', code: 'REJECTED_RECORD_NOT_FOUND', message: `no packets/rejected/${rejectedId}` };
  }
  const rec = state.rejected;
  const pkt = (rec.packet ?? {}) as Record<string, unknown>;

  // 2. Eligibility — only the intended recoverable condition.
  const reason = norm(rec.reason);
  if (reason !== RECOVERABLE_REJECTION_REASON) {
    return { action: 'reject', code: 'REJECTION_NOT_RECOVERABLE', message: `rejection reason '${reason}' is not recoverable (only ${RECOVERABLE_REJECTION_REASON})` };
  }

  // 3. Must be a pull.
  const reqType = norm(pkt.requestType) ?? norm(rec.requestType) ?? 'pull';
  if (reqType !== 'pull') {
    return { action: 'reject', code: 'NOT_A_PULL', message: `rejected record is requestType='${reqType}', not a pull` };
  }

  // 4. Ownership: same company + driver + well as the rejected pull.
  const recCompany = norm(pkt.companyId);
  const callerCompany = norm(input.caller?.companyId);
  if (recCompany && recCompany !== callerCompany) {
    return { action: 'reject', code: 'CROSS_COMPANY', message: 'caller company does not own the rejected pull' };
  }
  const recDriver = norm(pkt.driverId);
  const callerDriver = norm(input.caller?.driverId);
  if (!callerDriver || !recDriver || recDriver !== callerDriver) {
    return { action: 'reject', code: 'NOT_OWNER', message: 'caller is not the driver of the rejected pull' };
  }
  if (!(norm(pkt.wellName) ?? norm(rec.wellName))) {
    return { action: 'reject', code: 'WELL_MISMATCH', message: 'rejected record carries no wellName' };
  }

  // 5. Idempotency by the replacement's processed receipt (highest authority).
  if (state.replacementProcessed) {
    const provenance = norm((state.replacementProcessed as Record<string, unknown>).recoveredFromPacketId);
    if (provenance !== rejectedId) {
      return { action: 'reject', code: 'REPLACEMENT_ID_CONFLICT', message: `packets/processed/${replacementId} exists without recoveredFromPacketId=${rejectedId}` };
    }
    if (norm(rec.recoveredByPacketId) === replacementId) {
      return { action: 'noop_complete', code: 'ALREADY_RECOVERED', replacementPacketId: replacementId };
    }
    return { action: 'annotate_only', code: 'PROCESSED_AWAIT_ANNOTATION', replacementPacketId: replacementId };
  }

  // 6. The processor rejected the replacement itself → terminal review; never
  //    mark the original recovered.
  if (state.replacementRejected) {
    const r = norm((state.replacementRejected as Record<string, unknown>).reason) ?? 'rejected by processor';
    return { action: 'reject', code: 'REPLACEMENT_REJECTED', message: `replacement ${replacementId} was rejected by the processor (${r})` };
  }

  // 7. A prior claim/annotation under a DIFFERENT id → conflict (single-winner).
  const priorRecovered = norm(rec.recoveredByPacketId);
  if (priorRecovered && priorRecovered !== replacementId) {
    return { action: 'reject', code: 'RECOVERED_UNDER_DIFFERENT_ID', message: `already recovered by ${priorRecovered}` };
  }
  const claimId = norm(rec.recoveryClaim?.replacementPacketId);
  if (claimId && claimId !== replacementId) {
    return { action: 'reject', code: 'RECOVERED_UNDER_DIFFERENT_ID', message: `recovery already claimed by ${claimId}` };
  }

  // 8. Replacement already pending in incoming → in flight; never overwrite.
  if (state.replacementIncoming) {
    return { action: 'already_in_flight', code: 'REPLACEMENT_IN_INCOMING', replacementPacketId: replacementId };
  }

  // 9. Watermark preflight — corrected event must be newer than the live
  //    watermark now, or a newer pull arrived and this would be back-dated.
  const incomingMs = new Date(corrected.dateTimeUTC).getTime();
  if (!Number.isFinite(incomingMs)) {
    return { action: 'reject', code: 'MALFORMED_REPLACEMENT_TIME', message: `unparseable corrected.dateTimeUTC ${JSON.stringify(corrected.dateTimeUTC)}` };
  }
  const watermarkMs = state.watermarkDateTimeUTC ? new Date(state.watermarkDateTimeUTC).getTime() : NaN;
  if (Number.isFinite(watermarkMs) && incomingMs <= watermarkMs) {
    return { action: 'reject', code: 'REPLACEMENT_NOT_NEWER', message: `corrected time ${corrected.dateTimeUTC} is not newer than watermark ${state.watermarkDateTimeUTC} — a newer pull arrived; stop` };
  }

  // 10. Submit to the canonical processor.
  return { action: 'process', code: 'SUBMIT_REPLACEMENT', incomingPath: `packets/incoming/${replacementId}` };
}

/** Single-winner claim decision (applied inside an atomic transaction). */
export type ClaimDecision =
  | { decision: 'acquire'; value: { replacementPacketId: string; claimedAt: unknown } } // set the claim
  | { decision: 'matched' }                                                              // our own id already claimed
  | { decision: 'conflict'; existingReplacementId: string };                             // a different id won

export function planClaim(
  existingClaim: { replacementPacketId?: string } | null | undefined,
  replacementPacketId: string,
  claimedAt: unknown,
): ClaimDecision {
  const existing = norm(existingClaim?.replacementPacketId);
  if (!existing) return { decision: 'acquire', value: { replacementPacketId, claimedAt } };
  if (existing === replacementPacketId) return { decision: 'matched' };
  return { decision: 'conflict', existingReplacementId: existing };
}

/**
 * Build the replacement pull for packets/incoming. Every immutable field comes
 * from the preserved rejected record; only the corrected material fields come
 * from the request. The local display time is DERIVED from dateTimeUTC + the
 * record's timezone (single source of truth). predictedLevelInches is omitted
 * so the server reconstructs the correct at-pull-time prediction.
 */
export function buildReplacementIncomingPacket(
  input: RecoveryInput,
  rejected: RejectedRecord,
): Record<string, unknown> {
  const src = (rejected.packet ?? {}) as Record<string, unknown>;
  const wellName = norm(src.wellName) ?? norm(rejected.wellName);
  const timezone = norm(src.timezone);
  const packet: Record<string, unknown> = {
    packetId: input.replacementPacketId,
    idempotencyKey: input.replacementPacketId,
    requestType: 'pull',
    // Corrected material (the AM→PM fix + confirmed values).
    dateTimeUTC: input.corrected.dateTimeUTC,
    dateTime: deriveLocalDateTime(input.corrected.dateTimeUTC, timezone), // derived, not trusted
    tankLevelFeet: input.corrected.tankLevelFeet,
    bblsTaken: input.corrected.bblsTaken,
    wellDown: input.corrected.wellDown,
    // Immutable identity/provenance — from the server record ONLY.
    wellName,
    driverId: norm(src.driverId),
    driverName: norm(src.driverName),
    companyId: norm(src.companyId),
    ...(timezone ? { timezone } : {}),
    ...(src.wellDownIsAuthoritative === true ? { wellDownIsAuthoritative: true } : {}),
    recoveredFromPacketId: input.rejectedPacketId,
    // predictedLevelInches intentionally omitted (server reconstructs).
  };
  return packet;
}

/** Sibling-key update marking the rejected record recovered — never touches
 *  `.../packet`. */
export function buildRecoveryAnnotation(input: RecoveryInput, nowIso: string): Record<string, unknown> {
  const base = `packets/rejected/${input.rejectedPacketId}`;
  return {
    [`${base}/recoveredByPacketId`]: input.replacementPacketId,
    [`${base}/recoveredAt`]: nowIso,
    [`${base}/recoveryStatus`]: 'recovered',
    [`${base}/recoveryReason`]: 'Mechanism A: corrected replacement pull processed canonically; original preserved for audit.',
  };
}

// ── Deterministic operational runner ──────────────────────────────────────
// Drives one recovery to a terminal state so production can never stall at
// "processing_submitted" because nobody made the required second call. The
// bounded poll (maxAttempts × sleep) yields the SECOND step — annotate — as
// soon as the canonical processor writes the processed receipt. All effects are
// injected, so this unit-tests deterministically with scripted state sequences.

export interface RecoveryIO {
  readState(): Promise<RecoveryState>;
  /** Atomic single-winner claim on packets/rejected/<id>/recoveryClaim. */
  claimRecovery(replacementPacketId: string): Promise<ClaimResult>;
  /** Transactional set of packets/incoming/<id> ONLY if absent (never overwrite). */
  writeIncomingIfAbsent(replacementPacketId: string, packet: Record<string, unknown>): Promise<'written' | 'exists'>;
  /** Multi-location sibling-key annotation update. */
  annotate(update: Record<string, unknown>): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type ClaimResult = { ok: true } | { ok: false; existingReplacementId: string };

export type RecoveryOutcome =
  | { status: 'recovered'; replacementPacketId: string }
  | { status: 'already_recovered'; replacementPacketId: string }
  | { status: 'processing_submitted'; replacementPacketId: string }
  | { status: 'replacement_rejected'; replacementPacketId: string; reason: string }
  | { status: 'conflict'; code: RecoveryRejectCode; message: string }
  | { status: 'rejected'; code: RecoveryRejectCode; message: string };

export interface RunnerOptions { maxAttempts?: number; backoffMs?: number }

export async function executeRecovery(
  io: RecoveryIO,
  input: RecoveryInput,
  opts: RunnerOptions = {},
): Promise<RecoveryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const backoffMs = opts.backoffMs ?? 800;

  const s0 = await io.readState();
  const plan = planRecovery(input, s0);

  if (plan.action === 'reject') {
    const conflictCodes = new Set<RecoveryRejectCode>(['REPLACEMENT_ID_CONFLICT', 'RECOVERED_UNDER_DIFFERENT_ID', 'REPLACEMENT_REJECTED']);
    if (plan.code === 'REPLACEMENT_REJECTED') {
      return { status: 'replacement_rejected', replacementPacketId: input.replacementPacketId, reason: plan.message };
    }
    return { status: conflictCodes.has(plan.code) ? 'conflict' : 'rejected', code: plan.code, message: plan.message };
  }
  if (plan.action === 'noop_complete') {
    return { status: 'already_recovered', replacementPacketId: plan.replacementPacketId };
  }
  if (plan.action === 'annotate_only') {
    await io.annotate(buildRecoveryAnnotation(input, new Date(io.now()).toISOString()));
    return { status: 'recovered', replacementPacketId: plan.replacementPacketId };
  }

  // process | already_in_flight → ensure the claim + incoming write, then poll.
  if (plan.action === 'process') {
    const claim = await io.claimRecovery(input.replacementPacketId);
    if (!claim.ok) {
      return { status: 'conflict', code: 'RECOVERED_UNDER_DIFFERENT_ID', message: `recovery already claimed by ${claim.existingReplacementId}` };
    }
    await io.writeIncomingIfAbsent(input.replacementPacketId, buildReplacementIncomingPacket(input, s0.rejected as RejectedRecord));
  }

  // Bounded runner: wait for the canonical processor, then take the SECOND step.
  for (let i = 0; i < maxAttempts; i++) {
    const s = await io.readState();
    if (s.replacementProcessed) {
      const provenance = norm((s.replacementProcessed as Record<string, unknown>).recoveredFromPacketId);
      if (provenance !== input.rejectedPacketId) {
        return { status: 'conflict', code: 'REPLACEMENT_ID_CONFLICT', message: `processed ${input.replacementPacketId} lacks provenance to ${input.rejectedPacketId}` };
      }
      if (norm(s.rejected?.recoveredByPacketId) === input.replacementPacketId) {
        return { status: 'already_recovered', replacementPacketId: input.replacementPacketId };
      }
      await io.annotate(buildRecoveryAnnotation(input, new Date(io.now()).toISOString()));
      return { status: 'recovered', replacementPacketId: input.replacementPacketId };
    }
    if (s.replacementRejected) {
      const r = norm((s.replacementRejected as Record<string, unknown>).reason) ?? 'rejected by processor';
      return { status: 'replacement_rejected', replacementPacketId: input.replacementPacketId, reason: r };
    }
    if (i < maxAttempts - 1) await io.sleep(backoffMs);
  }
  // Not yet processed — idempotent; a later call finishes at annotate_only.
  return { status: 'processing_submitted', replacementPacketId: input.replacementPacketId };
}
