import { isPeriodId } from './shiftAuthority';
import type { DvirLedger, DvirSubject } from './dvirCompletion';

/** A pending Post-Trip for the currently open shift is normal work, not recovery. */
export function isDvirRecovery(ledger: DvirLedger | null, who: DvirSubject,
  authority: { driverId: string; companyId: string; initialized: boolean; openPeriodId: string | null } | null): boolean {
  return !!authority && authority.initialized === true
    && authority.driverId === who.driverId && authority.companyId === who.companyId
    && (authority.openPeriodId === null || isPeriodId(authority.openPeriodId))
    && !!ledger && ledger.schemaVersion === 1 && ledger.driverId === who.driverId
    && ledger.companyId === who.companyId && isPeriodId(ledger.shiftId)
    && ledger.shiftId !== authority.openPeriodId
    && ledger.postTripPending === true && !ledger.postTrip;
}

export const RECOVERY_REASONS = ['app_or_connection', 'phone_unavailable', 'forgot', 'other', 'prefer_not_to_say'] as const;
export function parseRecoveryFeedback(data: Record<string, unknown>) {
  if (!RECOVERY_REASONS.includes(data.reason as typeof RECOVERY_REASONS[number])
      || (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 500))) {
    throw new Error('invalid_recovery_feedback');
  }
  return { reason: data.reason as string, note: typeof data.note === 'string' ? data.note.trim() : '' };
}
