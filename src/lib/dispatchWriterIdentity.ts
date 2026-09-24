/**
 * Shared dispatch WRITER identity normalization (Firebase-free, node-testable).
 *
 * Companion to dispatchDriverIdentity.ts (the reader). Every Dashboard dispatch
 * create/reassign/split/project/transfer path stamps its driver identity through
 * this ONE helper so the stored contract is always:
 *   - driverId   : the driver's immutable canonical UUID (when the driver has one)
 *   - driverHash : the canonical UUID as the temporary compatibility value
 *                  (never the drivers/approved record key / passcode hash when a
 *                   canonical UUID exists)
 *   - driverName : the driver's REAL name — legalName preferred, then displayName —
 *                  never the login/username. (Field note: a driver profile's
 *                  displayName can literally be the login string, e.g. "Mikezfold",
 *                  while legalName is the real "Mike ZFold7 Burger"; legalName wins.)
 *
 * Legacy drivers with no canonical UUID keep the record key as the compatibility
 * driverHash and carry no driverId — the reader resolves them via the governed
 * legacy-alias fallback.
 */

import { resolveDispatchDriver, type DriverIdentity } from './dispatchDriverIdentity.ts';

const t = (v: unknown): string => (typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : '');

/** A canonical driver id is the immutable UUID (dash-bearing), never a 64-hex passcode hash. */
export function isCanonicalDriverId(id: unknown): boolean {
  const s = t(id);
  return s.length > 0 && s.includes('-');
}

/** Approved rows can retain a hash key after secure conversion. The governed
 * migratedToDriverId points to the canonical profile and must be used for writes. */
export function canonicalIdFromApprovedRow(
  key: string,
  row: { driverId?: unknown; migratedToDriverId?: unknown },
): string | undefined {
  for (const candidate of [row.driverId, row.migratedToDriverId, key]) {
    if (isCanonicalDriverId(candidate)) return t(candidate);
  }
  return undefined;
}

/** Real human name for a driver: legalName preferred, then displayName. Never a login-only fallback beyond these. */
export function driverRealName(d: Pick<DriverIdentity, 'legalName' | 'displayName'>): string {
  return t(d.legalName) || t(d.displayName) || '';
}

export interface AssignmentIdentity {
  /** canonical UUID; omitted only for legacy drivers with no canonical id */
  driverId?: string;
  /** canonical UUID (compat) when available, else the legacy record key */
  driverHash: string;
  /** real display name (legalName → displayName), never the login */
  driverName: string;
}

/**
 * Canonical identity fields to stamp on a dispatch for the selected driver.
 * Spread into the create/update record: `{ ...assignmentIdentityForDriver(driver) }`.
 */
export function assignmentIdentityForDriver(d: DriverIdentity): AssignmentIdentity {
  // A canonical id must be a real UUID — a 64-hex passcode hash in driverId/key is never promoted.
  const canonical = isCanonicalDriverId(d.driverId)
    ? t(d.driverId)
    : isCanonicalDriverId(d.key)
      ? t(d.key)
      : '';
  const driverName = driverRealName(d);
  if (canonical) {
    return { driverId: canonical, driverHash: canonical, driverName };
  }
  // Legacy driver with no canonical UUID: keep the record key as the compat hash.
  return { driverHash: t(d.key), driverName };
}

/** The platform-admin create callable requires the selected driver's company.
 * Scoped staff must omit it so the server derives their own company instead. */
export function dispatchCreateTargetForDriver(
  platformAdmin: boolean,
  driver: Pick<DriverIdentity, 'companyId'>,
): { companyId?: string } {
  if (!platformAdmin) return {};
  const companyId = t(driver.companyId);
  if (!companyId) throw new Error('Selected driver has no company. Refresh the driver list before dispatching.');
  return { companyId };
}

/** Resolve the target from the selected driver's governed roster identity.
 * The server independently checks this company against the driver and well. */
export function dispatchCreateTargetForAssignment(
  platformAdmin: boolean,
  record: Record<string, unknown>,
  drivers: DriverIdentity[],
): { companyId?: string } {
  if (!platformAdmin) return {};
  const driver = resolveDispatchDriver({
    driverId: typeof record.driverId === 'string' ? record.driverId : undefined,
    driverHash: typeof record.driverHash === 'string' ? record.driverHash : undefined,
  }, drivers);
  if (!driver) throw new Error('Selected driver is missing from the driver list. Refresh before dispatching.');
  return dispatchCreateTargetForDriver(true, driver);
}
