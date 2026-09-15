/**
 * Shared dispatch ↔ driver identity resolver (Firebase-free, node-testable).
 *
 * ONE resolver used by BOTH Dashboard Active Jobs and Well Queue attribution so a
 * dispatch always attaches to the correct driver and renders the driver's real
 * display name — never a login/hash.
 *
 * Identity contract:
 *   - Operational identity boundary is companyId + canonical driverId.
 *   - Match prefers the immutable canonical driverId.
 *   - A legacy driverHash resolves ONLY through governed identity fields on the driver
 *     record (its key / driverHash / bound legacyAliases) as a temporary compatibility
 *     fallback — never a typed name, never across companies.
 *   - Login names / passcode hashes / emails are auth/transition data, never keys and
 *     never shown as the driver name.
 */

export interface DriverIdentity {
  key: string;                 // drivers/approved record key (canonical UUID or legacy hash)
  driverId?: string;           // immutable canonical driver id
  driverHash?: string;         // legacy passcode hash (auth/transition only)
  companyId?: string;
  legacyAliases?: string[];    // governed legacy hashes bound to THIS driver
  displayName?: string;        // real profile display name (shown on cards)
  legalName?: string;
}

export interface DispatchIdentity {
  driverId?: string;
  driverHash?: string;
  companyId?: string;
  driverName?: string;         // stamped login/legacy name — display FALLBACK only, never a key
}

const t = (v: unknown): string => (typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : '');
const uniq = (a: string[]): string[] => [...new Set(a.filter(Boolean))];

/** Immutable canonical ids for a driver (driverId + the approved-record key). */
export function canonicalDriverIds(d: DriverIdentity): string[] {
  return uniq([t(d.driverId), t(d.key)]);
}
/** Governed legacy identities bound to a driver (hash + record key + explicit aliases). */
export function legacyDriverIds(d: DriverIdentity): string[] {
  return uniq([t(d.driverHash), t(d.key), ...((d.legacyAliases || []).map(t))]);
}

/** Same company? Enforced whenever BOTH sides declare a companyId (never cross-company). */
function sameCompany(dispatch: DispatchIdentity, driver: DriverIdentity): boolean {
  const a = t(dispatch.companyId), b = t(driver.companyId);
  if (a && b) return a === b;
  return true; // legacy record missing companyId → identity match still gated by id below
}

/**
 * Does this dispatch belong to this driver? Company boundary first, then canonical
 * driverId (preferred), then governed legacy-hash fallback. Never by name.
 */
export function dispatchMatchesDriver(dispatch: DispatchIdentity, driver: DriverIdentity): boolean {
  if (!sameCompany(dispatch, driver)) return false;          // never cross-company
  const did = t(dispatch.driverId);
  if (did && canonicalDriverIds(driver).includes(did)) return true;  // canonical (preferred)
  const legacy = legacyDriverIds(driver);
  const dh = t(dispatch.driverHash);
  if (dh && legacy.includes(dh)) return true;                // governed legacy hash fallback
  if (did && legacy.includes(did)) return true;              // canonical id stored in a legacy slot
  return false;
}

/**
 * Resolve a dispatch to its driver. A canonical driverId match wins outright; a legacy
 * match is used only if no canonical match exists. Returns null when unresolved (the
 * caller must NOT fall back to a login/hash for display).
 */
export function resolveDispatchDriver<T extends DriverIdentity>(
  dispatch: DispatchIdentity,
  drivers: T[],
): T | null {
  let legacyMatch: T | null = null;
  const did = t(dispatch.driverId);
  const dh = t(dispatch.driverHash);
  for (const d of drivers) {
    if (!sameCompany(dispatch, d)) continue;
    if (did && canonicalDriverIds(d).includes(did)) return d; // canonical wins immediately
    if (!legacyMatch) {
      const legacy = legacyDriverIds(d);
      if ((dh && legacy.includes(dh)) || (did && legacy.includes(did))) legacyMatch = d;
    }
  }
  return legacyMatch;
}

/** Stable grouping key for Active Jobs — the resolved canonical id, never a login/hash. */
export function dispatchDriverGroupKey(dispatch: DispatchIdentity, drivers: DriverIdentity[]): string {
  const d = resolveDispatchDriver(dispatch, drivers);
  if (d) return t(d.driverId) || t(d.key);
  return `unresolved:${t(dispatch.driverId) || t(dispatch.driverHash) || 'none'}`;
}

/**
 * Real driver name for display — legalName preferred, then displayName, NEVER the login/hash.
 * (A profile's displayName can literally be the login string, e.g. "Mikezfold", while
 * legalName holds the real "Mike ZFold7 Burger" — so legalName wins.)
 */
export function dispatchDriverDisplayName(dispatch: DispatchIdentity, drivers: DriverIdentity[]): string {
  const d = resolveDispatchDriver(dispatch, drivers);
  if (d) return t(d.legalName) || t(d.displayName) || 'Driver';
  return 'Unassigned driver';
}

export type DispatchActiveState = 'queued' | 'review' | 'accepted' | 'in_progress' | 'paused';

/**
 * Active-Jobs classification — every non-terminal DDJD state is represented, so a queued/
 * assigned/review job appears alongside started ones. Terminal states (declined, cancelled,
 * completed, dismissed) return null (they leave the active surface).
 */
export function dispatchActiveJobState(status: unknown): DispatchActiveState | null {
  switch (t(status)) {
    case 'pending': return 'queued';
    case 'pending_approval': return 'review';
    case 'accepted': return 'accepted';
    case 'in_progress': return 'in_progress';
    case 'paused': return 'paused';
    default: return null;
  }
}

/** Human label for a state chip. */
export function dispatchActiveJobStateLabel(state: DispatchActiveState): string {
  switch (state) {
    case 'queued': return 'Queued';
    case 'review': return 'Review';
    case 'accepted': return 'Accepted';
    case 'in_progress': return 'In progress';
    case 'paused': return 'Paused';
  }
}

/**
 * Phone-only exception gate: a DDJD job is exposed on the Dashboard only when the owning
 * company has Dashboard Dispatch enabled. A non-dispatch company stays phone-only.
 */
export function dispatchVisibleOnDashboard(companyDispatchEnabled: boolean): boolean {
  return companyDispatchEnabled === true;
}
