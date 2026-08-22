/**
 * Server-controlled one-to-one binding:
 *   canonical UUID  ↔  exact legacy approved key
 *
 * Bindings live under Admin-only RTDB paths, never on a client-readable
 * profile. Clients cannot mint, choose, or overwrite a binding.
 */
export const APPROVED_KEY_RE = /^[A-Za-z0-9_-]{16,}$/;
export const DRIVER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BindingStatus = 'active' | 'legacy_login_retired';

export interface IdentityBinding {
  driverId: string;
  approvedKey: string;
  status: BindingStatus;
  opId: string;
}

export function parseBinding(raw: unknown): IdentityBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.driverId !== 'string' || !DRIVER_UUID_RE.test(o.driverId)) return null;
  if (typeof o.approvedKey !== 'string' || !APPROVED_KEY_RE.test(o.approvedKey)) return null;
  if (o.status !== 'active' && o.status !== 'legacy_login_retired') return null;
  return {
    driverId: o.driverId,
    approvedKey: o.approvedKey,
    status: o.status,
    opId: typeof o.opId === 'string' ? o.opId : '',
  };
}

export type BindDecision =
  | { action: 'write' }
  | { action: 'already_exact' }
  | { action: 'refuse'; reason: string };

/**
 * 1:1 uniqueness. A UUID may bind to exactly one approved key and an
 * approved key may bind to exactly one UUID. Never merge identities.
 */
export function decideBindIdentity(input: {
  driverId: string;
  approvedKey: string;
  existingByDriver: IdentityBinding | null;
  existingByApproved: IdentityBinding | null;
}): BindDecision {
  if (!DRIVER_UUID_RE.test(input.driverId)) {
    return { action: 'refuse', reason: 'driver_id_malformed' };
  }
  if (!APPROVED_KEY_RE.test(input.approvedKey)) {
    return { action: 'refuse', reason: 'approved_key_malformed' };
  }
  const byDriver = input.existingByDriver;
  const byApproved = input.existingByApproved;
  if (byDriver && byDriver.approvedKey !== input.approvedKey) {
    return { action: 'refuse', reason: 'driver_already_bound' };
  }
  if (byApproved && byApproved.driverId !== input.driverId) {
    return { action: 'refuse', reason: 'approved_key_already_bound' };
  }
  if (
    byDriver
    && byApproved
    && byDriver.driverId === input.driverId
    && byDriver.approvedKey === input.approvedKey
    && byApproved.driverId === input.driverId
    && byApproved.approvedKey === input.approvedKey
  ) {
    return { action: 'already_exact' };
  }
  if (byDriver && !byApproved && byDriver.approvedKey === input.approvedKey) {
    return { action: 'already_exact' };
  }
  if (byApproved && !byDriver && byApproved.driverId === input.driverId) {
    return { action: 'already_exact' };
  }
  return { action: 'write' };
}

export type RetireDecision =
  | { action: 'retire' }
  | { action: 'already_retired' }
  | { action: 'refuse'; reason: string };

/**
 * Legacy login retirement is a separate audited action. It requires the
 * secure identity and hydration to already exist. It never deletes history
 * and never removes the binding used for trusted history alias resolution.
 */
export function decideRetireLegacyLogin(input: {
  binding: IdentityBinding | null;
  secureLoginProven: boolean;
  hydrationProven: boolean;
}): RetireDecision {
  if (!input.binding) return { action: 'refuse', reason: 'binding_missing' };
  if (!input.secureLoginProven) return { action: 'refuse', reason: 'secure_login_unproven' };
  if (!input.hydrationProven) return { action: 'refuse', reason: 'hydration_unproven' };
  if (input.binding.status === 'legacy_login_retired') return { action: 'already_retired' };
  return { action: 'retire' };
}

export const BINDING_BY_DRIVER = (driverId: string) =>
  `drivers/identityBindings/byDriver/${driverId}`;
export const BINDING_BY_APPROVED = (approvedKey: string) =>
  `drivers/identityBindings/byApproved/${approvedKey}`;
