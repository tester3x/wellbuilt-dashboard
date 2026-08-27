// recoverRejectedPull.ts — governed, company-scoped recovery of a pull that
// was losslessly quarantined to packets/rejected (e.g. STALE_PULL_TIME from an
// AM/PM entry mistake). Mechanism A: submit ONE corrected replacement pull with
// a NEW stable packet id, processed by the CANONICAL pull processor
// (processIncomingPull), carrying provenance back to the rejected original —
// then mark the rejected record recovered ONLY after the replacement has an
// authoritative processed receipt.
//
// This module is PURE and injected (no firebase-admin / firebase-functions
// import) so the decision ladder unit-tests without an emulator, exactly like
// packetGuards.ts. The thin authenticated onCall wrapper lives in
// recoverRejectedPullCallable.ts and supplies the real read/write surface.
//
// Design invariants (Gabriel 5 incident, 8/27/2026):
//  - The original rejected payload is NEVER deleted or altered — only annotated
//    with recovery metadata on sibling keys (recoveredByPacketId/recoveredAt/…).
//  - The replacement is processed canonically (written to packets/incoming so
//    processIncomingPull computes processed/outgoing/performance/AFR/production).
//    We do NOT hand-construct materialized state.
//  - Idempotent: the same (rejectedId, replacementId) request may be retried;
//    a completed replacement never yields a second processed row; a partial
//    failure after processing can finish the missing annotation without
//    reprocessing the pull.
//  - Stops if a newer pull for the well makes the corrected event no longer
//    newer than the live watermark (the corrected pull would itself be
//    back-dated — out of scope for this recovery).
//  - No well/company hardcoding; every identity comes from the rejected record
//    and the authenticated caller.

/** A firebase key must not contain . # $ [ ] / and must be non-empty. */
export function isFirebaseKeySafe(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[.#$/[\]]/.test(value);
}

/** Corrected material fields for the replacement pull. Time is authoritative
 *  UTC; the AM/PM fix lives entirely in dateTimeUTC. */
export interface CorrectedPullFields {
  dateTimeUTC: string;
  /** Optional local display string; derived by the wrapper when omitted. */
  dateTime?: string;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown: boolean;
}

export interface RecoveryInput {
  rejectedPacketId: string;
  /** One stable replacement id, minted once and reused verbatim on retry. */
  replacementPacketId: string;
  corrected: CorrectedPullFields;
  /** Authenticated caller identity (from driver claims). */
  caller: { companyId?: string; driverId: string };
}

/** The preserved quarantine record at packets/rejected/<rejectedPacketId>. */
export interface RejectedRecord {
  packetId?: string;
  packet?: Record<string, unknown>;
  wellName?: string;
  requestType?: string;
  reason?: string;
  /** Present once a prior recovery annotated it. */
  recoveredByPacketId?: string;
  recoveredAt?: string;
  recoveryStatus?: string;
}

export interface RecoveryState {
  /** packets/rejected/<rejectedPacketId> */
  rejected: RejectedRecord | null;
  /** packets/processed/<replacementPacketId> */
  replacementProcessed: Record<string, unknown> | null;
  /** The well's current outgoing watermark (lastPullDateTimeUTC), or null. */
  watermarkDateTimeUTC: string | null;
  nowMs: number;
}

export type RecoveryPlan =
  | { action: 'reject'; code: RecoveryRejectCode; message: string }
  | { action: 'noop_complete'; code: 'ALREADY_RECOVERED'; replacementPacketId: string }
  | { action: 'annotate_only'; code: 'PROCESSED_AWAIT_ANNOTATION'; replacementPacketId: string }
  | { action: 'process'; code: 'SUBMIT_REPLACEMENT'; incomingPath: string };

export type RecoveryRejectCode =
  | 'INVALID_ARGUMENT'
  | 'REJECTED_RECORD_NOT_FOUND'
  | 'NOT_A_PULL'
  | 'CROSS_COMPANY'
  | 'NOT_OWNER'
  | 'WELL_MISMATCH'
  | 'MALFORMED_REPLACEMENT_TIME'
  | 'REPLACEMENT_NOT_NEWER'
  | 'REPLACEMENT_ID_CONFLICT'
  | 'RECOVERED_UNDER_DIFFERENT_ID';

const norm = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/**
 * Pure decision ladder. Given the request and the current server state,
 * returns exactly one plan. The wrapper executes it and never re-derives the
 * decision. Order matters: identity/ownership first, then idempotency by the
 * replacement's processed receipt, then the watermark preflight.
 */
export function planRecovery(input: RecoveryInput, state: RecoveryState): RecoveryPlan {
  const rejectedId = norm(input?.rejectedPacketId);
  const replacementId = norm(input?.replacementPacketId);

  // 0. Argument shape.
  if (!rejectedId || !replacementId) {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'rejectedPacketId and replacementPacketId are required' };
  }
  if (!isFirebaseKeySafe(replacementId)) {
    return { action: 'reject', code: 'INVALID_ARGUMENT', message: 'replacementPacketId is not a valid firebase key' };
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

  // 1. The rejected record must exist.
  if (!state.rejected) {
    return { action: 'reject', code: 'REJECTED_RECORD_NOT_FOUND', message: `no packets/rejected/${rejectedId}` };
  }
  const rec = state.rejected;
  const pkt = (rec.packet ?? {}) as Record<string, unknown>;

  // 2. Only a pull is recoverable this way.
  const reqType = norm(pkt.requestType) ?? norm(rec.requestType) ?? 'pull';
  if (reqType !== 'pull') {
    return { action: 'reject', code: 'NOT_A_PULL', message: `rejected record is requestType='${reqType}', not a pull` };
  }

  // 3. Ownership: same company + same driver + same well as the rejected pull.
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
  const well = norm(pkt.wellName) ?? norm(rec.wellName);
  if (!well) {
    return { action: 'reject', code: 'WELL_MISMATCH', message: 'rejected record carries no wellName' };
  }

  // 4. Idempotency by the replacement's processed receipt.
  if (state.replacementProcessed) {
    const provenance = norm((state.replacementProcessed as Record<string, unknown>).recoveredFromPacketId);
    if (provenance !== rejectedId) {
      // A processed row already owns this id but is NOT our recovery — never
      // overwrite it and never create a second row.
      return { action: 'reject', code: 'REPLACEMENT_ID_CONFLICT', message: `packets/processed/${replacementId} exists without recoveredFromPacketId=${rejectedId}` };
    }
    if (norm(rec.recoveredByPacketId) === replacementId) {
      return { action: 'noop_complete', code: 'ALREADY_RECOVERED', replacementPacketId: replacementId };
    }
    // Processed succeeded but the rejected record is not yet annotated — finish
    // ONLY the annotation, without reprocessing the pull.
    return { action: 'annotate_only', code: 'PROCESSED_AWAIT_ANNOTATION', replacementPacketId: replacementId };
  }

  // 5. Not processed yet. If a prior recovery already annotated a DIFFERENT
  //    replacement, stop — do not create a second recovery.
  const priorRecovered = norm(rec.recoveredByPacketId);
  if (priorRecovered && priorRecovered !== replacementId) {
    return { action: 'reject', code: 'RECOVERED_UNDER_DIFFERENT_ID', message: `already recovered by ${priorRecovered}` };
  }

  // 6. Watermark preflight — the corrected event must be newer than the live
  //    watermark right now, or a newer pull has arrived and the corrected pull
  //    would itself be back-dated (out of scope for this recovery).
  const incomingMs = new Date(corrected.dateTimeUTC).getTime();
  if (!Number.isFinite(incomingMs)) {
    return { action: 'reject', code: 'MALFORMED_REPLACEMENT_TIME', message: `unparseable corrected.dateTimeUTC ${JSON.stringify(corrected.dateTimeUTC)}` };
  }
  const watermarkMs = state.watermarkDateTimeUTC ? new Date(state.watermarkDateTimeUTC).getTime() : NaN;
  if (Number.isFinite(watermarkMs) && incomingMs <= watermarkMs) {
    return { action: 'reject', code: 'REPLACEMENT_NOT_NEWER', message: `corrected time ${corrected.dateTimeUTC} is not newer than watermark ${state.watermarkDateTimeUTC} — a newer pull arrived; stop` };
  }

  // 7. Submit the replacement to the canonical processor.
  return { action: 'process', code: 'SUBMIT_REPLACEMENT', incomingPath: `packets/incoming/${replacementId}` };
}

/**
 * Build the replacement pull packet for packets/incoming. The canonical
 * processIncomingPull trigger consumes it and materializes everything. Provenance
 * (recoveredFromPacketId) travels onto the processed row. predictedLevelInches
 * is deliberately OMITTED so the server reconstructs the correct at-pull-time
 * prediction from the prior outgoing response (index.ts performance fallback);
 * carrying the stale AM value would poison the accuracy row.
 */
export function buildReplacementIncomingPacket(
  input: RecoveryInput,
  rejected: RejectedRecord,
): Record<string, unknown> {
  const src = (rejected.packet ?? {}) as Record<string, unknown>;
  const wellName = norm(src.wellName) ?? norm(rejected.wellName);
  const packet: Record<string, unknown> = {
    // Identity — one stable new id, its own idempotency key.
    packetId: input.replacementPacketId,
    idempotencyKey: input.replacementPacketId,
    requestType: 'pull',
    // Corrected material fields (the AM→PM fix + confirmed values).
    dateTimeUTC: input.corrected.dateTimeUTC,
    ...(norm(input.corrected.dateTime) ? { dateTime: input.corrected.dateTime } : {}),
    tankLevelFeet: input.corrected.tankLevelFeet,
    bblsTaken: input.corrected.bblsTaken,
    wellDown: input.corrected.wellDown,
    // Preserved provenance/identity from the rejected original.
    wellName,
    driverId: norm(src.driverId),
    driverName: norm(src.driverName),
    companyId: norm(src.companyId),
    ...(norm(src.timezone) ? { timezone: src.timezone } : {}),
    ...(src.wellDownIsAuthoritative === true ? { wellDownIsAuthoritative: true } : {}),
    // Recovery provenance — travels onto the processed row.
    recoveredFromPacketId: input.rejectedPacketId,
    // predictedLevelInches intentionally omitted (server reconstructs).
  };
  return packet;
}

/**
 * Sibling-key update that marks the rejected record recovered WITHOUT touching
 * its preserved `.packet` payload. Applied via a rootRef multi-location update.
 */
export function buildRecoveryAnnotation(
  input: RecoveryInput,
  nowIso: string,
): Record<string, unknown> {
  const base = `packets/rejected/${input.rejectedPacketId}`;
  return {
    [`${base}/recoveredByPacketId`]: input.replacementPacketId,
    [`${base}/recoveredAt`]: nowIso,
    [`${base}/recoveryStatus`]: 'recovered',
    [`${base}/recoveryReason`]: 'Mechanism A: corrected replacement pull processed canonically; original preserved for audit.',
  };
}
