/**
 * Client wrapper for the governed staff batched shift-status read.
 * Calls the deployed callable `staffResolveCompanyDriverShifts` and returns a map
 * keyed by canonical driverId. Any error (permission, network, absent callable)
 * yields an empty map — the caller renders GRAY "unavailable", never a false red.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import { parseShiftResolveEnvelope, type ShiftResolveResult } from './shiftDotCore';

export const STAFF_RESOLVE_SHIFTS_CALLABLE = 'staffResolveCompanyDriverShifts';

export interface CompanyDriverShifts {
  resultsByDriverId: Map<string, ShiftResolveResult>;
  companyId: string | null;
  asOf: string | null;
  error: boolean;
}

interface WireResult { driverId: string; state: 'open' | 'none' | 'unverifiable'; asOf: string }

/**
 * Resolve shift state for a bounded set of canonical driverIds. Company scope is
 * derived SERVER-side from the caller; the optional companyId is honored only for
 * platform admins with viewAllCompanies (ignored otherwise).
 */
export async function resolveCompanyDriverShifts(
  driverIds: string[],
  companyId?: string,
): Promise<CompanyDriverShifts> {
  const empty: CompanyDriverShifts = { resultsByDriverId: new Map(), companyId: null, asOf: null, error: false };
  const ids = [...new Set((driverIds || []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean))];
  if (ids.length === 0) return empty;
  try {
    const fn = httpsCallable(getFirebaseFunctions(), STAFF_RESOLVE_SHIFTS_CALLABLE);
    const payload: Record<string, unknown> = { driverIds: ids };
    if (companyId) payload.companyId = companyId;
    const res = (await fn(payload)) as { data: { results?: WireResult[]; companyId?: string; asOf?: string } };
    const parsed = parseShiftResolveEnvelope(res.data);
    return { ...parsed, error: false };
  } catch {
    // Missing/undeployed callable, permission failure, or network error → gray.
    return { ...empty, error: true };
  }
}
