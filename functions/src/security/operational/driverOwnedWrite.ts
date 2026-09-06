/**
 * Auth-first identity gate for driver-owned writes.
 * Empty/malformed payload is never proof of authentication.
 */

export type VerifiedDriver = {
  uid: string;
  driverId: string;
  companyId: string;
  displayName?: string;
  authSource: string;
};

export type IdentityDecision =
  | { ok: true; driver: VerifiedDriver }
  | { ok: false; error: 'unauthenticated' | 'malformed_identity' | 'cross_company' | 'wrong_driver' };

const PRIVILEGE_KEYS = [
  'isAdmin',
  'roles',
  'role',
  'manageDrivers',
  'wellbuiltAdmin',
  'platformAdminEnabled',
] as const;

export function requireVerifiedDriverIdentity(raw: {
  uid?: string;
  driverId?: string;
  companyId?: string;
  displayName?: string;
  authSource?: string;
} | null | undefined): IdentityDecision {
  if (!raw?.uid) return { ok: false, error: 'unauthenticated' };
  const driverId = typeof raw.driverId === 'string' ? raw.driverId.trim() : '';
  const companyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
  if (!driverId || !companyId) return { ok: false, error: 'malformed_identity' };
  return {
    ok: true,
    driver: {
      uid: raw.uid,
      driverId,
      companyId,
      displayName: raw.displayName,
      authSource: raw.authSource || 'claims',
    },
  };
}

export function rejectSpoofedResourceIdentity(
  driver: VerifiedDriver,
  resource: { driverId?: unknown; companyId?: unknown },
): IdentityDecision {
  const company = typeof resource.companyId === 'string' ? resource.companyId.trim() : '';
  if (company && company !== driver.companyId) {
    return { ok: false, error: 'cross_company' };
  }
  const driverId = typeof resource.driverId === 'string' ? resource.driverId.trim() : '';
  if (driverId && driverId !== driver.driverId) {
    return { ok: false, error: 'wrong_driver' };
  }
  return { ok: true, driver };
}

export function stampDriverOwnedResource(
  driver: VerifiedDriver,
  resource: Record<string, unknown>,
): Record<string, unknown> {
  const stamped: Record<string, unknown> = { ...resource };
  for (const key of PRIVILEGE_KEYS) delete stamped[key];
  stamped.driverId = driver.driverId;
  stamped.companyId = driver.companyId;
  if (driver.displayName && typeof stamped.driverName !== 'string') {
    stamped.driverName = driver.displayName;
  }
  stamped.ingestedBy = driver.uid;
  stamped.authSource = driver.authSource;
  return stamped;
}

/** Simulated ingest/upsert write gate used by unit tests. */
export function executeDriverOwnedWrite(input: {
  driverRaw: {
    uid?: string;
    driverId?: string;
    companyId?: string;
    displayName?: string;
    authSource?: string;
  } | null;
  payload: unknown;
  payloadKey: 'packet' | 'invoice';
  store: { writes: Record<string, unknown>[] };
}): { ok: true; duplicate?: boolean } | { ok: false; error: string } {
  const identity = requireVerifiedDriverIdentity(input.driverRaw);
  if (!identity.ok) return { ok: false, error: identity.error };
  if (input.payload == null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    return { ok: false, error: `${input.payloadKey}_required` };
  }
  const body = input.payload as Record<string, unknown>;
  const spoof = rejectSpoofedResourceIdentity(identity.driver, body);
  if (!spoof.ok) return { ok: false, error: spoof.error };
  const stamped = stampDriverOwnedResource(identity.driver, body);
  const idem = typeof stamped.idempotencyKey === 'string' ? stamped.idempotencyKey : '';
  if (idem) {
    const existing = input.store.writes.find((w) => w.idempotencyKey === idem);
    if (existing) return { ok: true, duplicate: true };
  }
  input.store.writes.push(stamped);
  return { ok: true };
}
