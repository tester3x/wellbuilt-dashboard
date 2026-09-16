/**
 * Pure decision core for the staff batched shift-status read
 * (`staffResolveCompanyDriverShifts`). No I/O — input validation and company-scope
 * resolution only; the per-driver decision reuses the governed `decideResolve`.
 *
 * Guarantees encoded here:
 *   - company scope is derived from the AUTHENTICATED staff caller, never trusted
 *     from the client; a non-platform caller's client-supplied companyId is ignored;
 *   - bounded, de-duplicated driverId list; empty/oversized input is rejected;
 *   - read-only: nothing here mutates or writes.
 */

export const MAX_STAFF_SHIFT_DRIVER_IDS = 200;

export type DriverIdsResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'not_array' | 'empty' | 'too_many' | 'invalid_id' };

/** Validate + normalize (trim, drop blanks, de-dupe) the requested driverIds. */
export function normalizeDriverIds(input: unknown): DriverIdsResult {
  if (!Array.isArray(input)) return { ok: false, reason: 'not_array' };
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (input.length > MAX_STAFF_SHIFT_DRIVER_IDS) return { ok: false, reason: 'too_many' };
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, reason: 'invalid_id' };
    const id = raw.trim();
    if (!id) return { ok: false, reason: 'invalid_id' };
    if (!out.includes(id)) out.push(id);
  }
  return { ok: true, ids: out };
}

export interface StaffScopeCaller {
  companyId?: string;
  isPlatformAdmin: boolean;
  caps: string[];
}

export type ScopeCompanyResult =
  | { ok: true; companyId: string }
  | { ok: false; reason: 'unscoped_caller' };

/**
 * The company whose drivers this caller may read.
 *   - Company-scoped staff → their own companyId (any client-supplied companyId is IGNORED).
 *   - Platform admin WITH viewAllCompanies → the client-supplied companyId (legitimate
 *     cross-company view); without a target, unscoped.
 *   - Anyone else with no company → unscoped (rejected).
 */
export function resolveStaffScopeCompany(
  caller: StaffScopeCaller,
  clientCompanyId: unknown,
): ScopeCompanyResult {
  const own = typeof caller.companyId === 'string' ? caller.companyId.trim() : '';
  if (own) return { ok: true, companyId: own };
  const client = typeof clientCompanyId === 'string' ? clientCompanyId.trim() : '';
  if (caller.isPlatformAdmin && caller.caps.includes('viewAllCompanies') && client) {
    return { ok: true, companyId: client };
  }
  return { ok: false, reason: 'unscoped_caller' };
}

export type ShiftDriverState = 'open' | 'none' | 'unverifiable';

export interface StaffShiftDriverResult {
  driverId: string;
  state: ShiftDriverState;
  asOf: string;
}

/** Shape one per-driver result from a governed decideResolve outcome. */
export function buildStaffShiftResult(
  driverId: string,
  resolve: { state: ShiftDriverState },
  asOf: string,
): StaffShiftDriverResult {
  return { driverId, state: resolve.state, asOf };
}
