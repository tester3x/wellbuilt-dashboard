/** Minimal completion ledger. No signature text, photos or report body. */
export type DvirPhase = 'pre_trip' | 'post_trip';
export interface DvirSubject { driverId: string; companyId: string }
export interface DvirCompletion {
  inspectionId: string;
  phase: DvirPhase;
  completedAt: string;
  reportDigest: string;
}
export interface DvirLedger extends DvirSubject {
  schemaVersion: 1;
  shiftId: string;
  preTrip: DvirCompletion | null;
  postTrip: DvirCompletion | null;
  postTripPending: boolean;
  postTripStarted: boolean;
  origin?: 'shift_authority' | 'legacy_local_recovery';
}

export function assertExpectedOwner(data: Record<string, unknown>, who: DvirSubject): void {
  if (data.expectedDriverId !== who.driverId || data.expectedCompanyId !== who.companyId) {
    throw new Error('dvir_owner_changed');
  }
}

export function assertLedgerOwner(record: DvirLedger, who: DvirSubject, shiftId: string): void {
  if (record.schemaVersion !== 1 || record.driverId !== who.driverId
      || record.companyId !== who.companyId || record.shiftId !== shiftId) {
    throw new Error('dvir_ledger_owner_mismatch');
  }
}

export function emptyLedger(who: DvirSubject, shiftId: string): DvirLedger {
  return { ...who, schemaVersion: 1, shiftId, preTrip: null, postTrip: null,
    postTripPending: false, postTripStarted: false };
}

export function parseCompletion(data: Record<string, unknown>, nowMs: number): DvirCompletion {
  if (typeof data.inspectionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(data.inspectionId)
      || (data.phase !== 'pre_trip' && data.phase !== 'post_trip')
      || typeof data.completedAt !== 'string' || !Number.isFinite(Date.parse(data.completedAt))
      || Date.parse(data.completedAt) > nowMs + 300000
      || typeof data.reportDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.reportDigest)) {
    throw new Error('invalid_dvir_completion');
  }
  // No age cutoff: genuine lingering inspections still need completion/backfill.
  return { inspectionId: data.inspectionId, phase: data.phase,
    completedAt: data.completedAt, reportDigest: data.reportDigest };
}

export function recordCompletion(ledger: DvirLedger, completion: DvirCompletion): DvirLedger {
  const key = completion.phase === 'pre_trip' ? 'preTrip' : 'postTrip';
  const existing = ledger[key];
  if (existing) {
    if (existing.inspectionId !== completion.inspectionId
        || existing.completedAt !== completion.completedAt
        || existing.reportDigest !== completion.reportDigest) {
      throw new Error('dvir_completion_conflict');
    }
    return ledger;
  }
  const next = { ...ledger, [key]: completion };
  next.postTripPending = next.postTrip === null;
  return next;
}

/** Old Post-Trips are actionable work, never a global conflict barrier. */
export function selectDvirEntry(
  records: DvirLedger[], who: DvirSubject, requested: { shiftId: string; phase: DvirPhase },
): { binding: { shiftId: string; phase: DvirPhase }; recovery: boolean } {
  const pending = records.filter(r => r.schemaVersion === 1
    && r.driverId === who.driverId && r.companyId === who.companyId
    && r.postTripPending === true && !r.postTrip
    && (r.shiftId !== requested.shiftId || r.postTripStarted || requested.phase === 'post_trip'));
  pending.sort((a, b) => a.shiftId.localeCompare(b.shiftId));
  if (pending[0]) {
    return { binding: { shiftId: pending[0].shiftId, phase: 'post_trip' },
      recovery: pending[0].shiftId !== requested.shiftId || requested.phase !== 'post_trip' };
  }
  return { binding: requested, recovery: false };
}
