// ── Tenant containment gate (7/9) ───────────────────────────────────────────
// The operational RTDB well pool (well_config / packets/* / performance/*) is
// keyed by bare well name and has NO tenancy or operator dimension — it is
// de-facto Liquid Gold's data from the single-tenant era. Until wells gain
// real ownership (structural migration packet), scoped users of any OTHER
// company must not see that pool at all.
//
// Rule:
//   - unscoped WB admin (no companyId)      → global view (unchanged)
//   - companyId === 'liquid-gold'           → current view (their data)
//   - any other companyId (e.g. Home Hauling) → empty state
//
// This is deliberately a display gate, not a filter — there is nothing on the
// well records to filter BY. Do not extend this to imply assignedOperators ⇒
// well ownership; that mapping does not exist yet.

interface ScopedUser {
  companyId?: string;
}

/** The one tenant whose data the legacy global well pool actually is. */
export const LEGACY_WELL_POOL_COMPANY_ID = 'liquid-gold';

/** True when this user may see the global RTDB well pool (well status,
 *  routes, pull history, performance). */
export function canViewGlobalWellPool(user: ScopedUser | null | undefined): boolean {
  if (!user) return false;
  return !user.companyId || user.companyId === LEGACY_WELL_POOL_COMPANY_ID;
}
