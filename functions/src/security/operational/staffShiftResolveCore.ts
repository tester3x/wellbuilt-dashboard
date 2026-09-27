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

/**
 * May this caller view a given driver's shift status? This MIRRORS the client's
 * `docBelongsToTenant` exactly, so the dots resolve for precisely the drivers the
 * dispatch page already shows this caller — and tightens scoping so a company
 * dispatcher only ever sees their OWN company's dots:
 *   - caller with NO companyId (platform admin / unscoped staff) → sees all;
 *   - caller company === the driver's company → yes;
 *   - legacy-well-pool caller may view company-less (legacy) driver records;
 *   - otherwise → no (that driver resolves 'unverifiable' — never leaked).
 */
export function callerMayViewCompany(
  caller: StaffScopeCaller,
  driverCompanyId: string | null | undefined,
  legacyWellPoolCompanyId: string,
): boolean {
  const own = typeof caller.companyId === 'string' ? caller.companyId.trim() : '';
  const dc = typeof driverCompanyId === 'string' ? driverCompanyId.trim() : '';
  if (!own) return true; // see-all (matches docBelongsToTenant(!userCompanyId) === true)
  if (dc && dc === own) return true;
  if (own === legacyWellPoolCompanyId && !dc) return true;
  return false;
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
