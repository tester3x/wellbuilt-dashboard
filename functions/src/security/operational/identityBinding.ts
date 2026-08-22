import { createHash } from 'crypto';

/**
 * Server-controlled one-to-one binding:
 *   canonical UUID  ↔  exact legacy approved key
 *
 * Both directions are one atomic record pair. One-sided state is incomplete
 * (repair or refuse) — never already_exact. Bindings live under Admin-only
 * RTDB paths, never on a client-readable profile.
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

export function bindingsAgree(a: IdentityBinding | null, b: IdentityBinding | null): boolean {
  if (!a || !b) return false;
  return a.driverId === b.driverId
    && a.approvedKey === b.approvedKey
    && a.status === b.status
    && a.opId === b.opId;
}

export type BindDecision =
  | { action: 'write'; payload: IdentityBinding }
  | { action: 'repair'; payload: IdentityBinding }
  | { action: 'already_exact' }
  | { action: 'refuse'; reason: string };

function pairMatches(b: IdentityBinding, driverId: string, approvedKey: string): boolean {
  return b.driverId === driverId && b.approvedKey === approvedKey;
}

/**
 * 1:1 uniqueness. already_exact only when BOTH records exist and agree on
 * UUID, approved key, status, and opId. One-sided state is repair (same pair)
 * or refuse (foreign pair). Concurrent cross-bind is refuse.
 */
export function decideBindIdentity(input: {
  driverId: string;
  approvedKey: string;
  status?: BindingStatus;
  opId: string;
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
  const intended: IdentityBinding = {
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    status: input.status || 'active',
    opId: input.opId,
  };

  if (byDriver && !pairMatches(byDriver, input.driverId, input.approvedKey)) {
    return { action: 'refuse', reason: 'driver_already_bound' };
  }
  if (byApproved && !pairMatches(byApproved, input.driverId, input.approvedKey)) {
    return { action: 'refuse', reason: 'approved_key_already_bound' };
  }

  if (byDriver && byApproved) {
    if (bindingsAgree(byDriver, byApproved) && pairMatches(byDriver, input.driverId, input.approvedKey)) {
      if (byDriver.status === intended.status) return { action: 'already_exact' };
      return {
        action: 'repair',
        payload: { ...byDriver, status: intended.status },
      };
    }
    return {
      action: 'repair',
      payload: {
        driverId: input.driverId,
        approvedKey: input.approvedKey,
        status: intended.status,
        opId: byDriver.opId === byApproved.opId ? byDriver.opId : intended.opId,
      },
    };
  }

  if (byDriver && !byApproved) {
    return {
      action: 'repair',
      payload: {
        driverId: byDriver.driverId,
        approvedKey: byDriver.approvedKey,
        status: intended.status,
        opId: byDriver.opId,
      },
    };
  }
  if (byApproved && !byDriver) {
    return {
      action: 'repair',
      payload: {
        driverId: byApproved.driverId,
        approvedKey: byApproved.approvedKey,
        status: intended.status,
        opId: byApproved.opId,
      },
    };
  }

  return { action: 'write', payload: intended };
}

export function decideBindingTerminalProof(input: {
  driverId: string;
  approvedKey: string;
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
}): { ok: true; binding: IdentityBinding } | { ok: false; reason: string } {
  if (!input.byDriver && !input.byApproved) {
    return { ok: false, reason: 'binding_missing' };
  }
  if (!input.byDriver || !input.byApproved) {
    return { ok: false, reason: 'binding_incomplete' };
  }
  if (!bindingsAgree(input.byDriver, input.byApproved)) {
    return { ok: false, reason: 'binding_disagree' };
  }
  if (input.byDriver.driverId !== input.driverId) {
    return { ok: false, reason: 'binding_driver_mismatch' };
  }
  if (input.byDriver.approvedKey !== input.approvedKey) {
    return { ok: false, reason: 'binding_key_mismatch' };
  }
  return { ok: true, binding: input.byDriver };
}

export interface IdentityProofRecord {
  secureLoginAt: number | null;
  secureLoginDriverId: string | null;
  secureLoginUid: string | null;
  hydrationAt: number | null;
  hydrationDriverId: string | null;
}

export function parseIdentityProof(raw: unknown): IdentityProofRecord {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    secureLoginAt: typeof o.secureLoginAt === 'number' && Number.isFinite(o.secureLoginAt) ? o.secureLoginAt : null,
    secureLoginDriverId: typeof o.secureLoginDriverId === 'string' ? o.secureLoginDriverId : null,
    secureLoginUid: typeof o.secureLoginUid === 'string' ? o.secureLoginUid : null,
    hydrationAt: typeof o.hydrationAt === 'number' && Number.isFinite(o.hydrationAt) ? o.hydrationAt : null,
    hydrationDriverId: typeof o.hydrationDriverId === 'string' ? o.hydrationDriverId : null,
  };
}

export function secureLoginIsProven(proof: IdentityProofRecord, driverId: string): boolean {
  return !!proof.secureLoginAt && proof.secureLoginDriverId === driverId;
}

export function hydrationIsProven(proof: IdentityProofRecord, driverId: string): boolean {
  return !!proof.hydrationAt && proof.hydrationDriverId === driverId;
}

export type RetireDecision =
  | { action: 'retire'; surviving: IdentityBinding; complete: boolean }
  | { action: 'repair'; surviving: IdentityBinding; complete: boolean }
  | { action: 'already_retired'; surviving: IdentityBinding; complete: boolean }
  | { action: 'refuse'; reason: string };

export type SurvivingPairResult =
  | { ok: true; surviving: IdentityBinding; complete: boolean }
  | { ok: false; reason: string };

/**
 * Resolve the surviving UUID↔approvedKey pair from server binding records.
 * Never uses display-name equality or a client-supplied approved key.
 * Ambiguous or conflicting one-sided state is refused.
 */
export function resolveSurvivingRetirementPair(input: {
  requestedDriverId: string;
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
  byApprovedOwnedByDriver?: IdentityBinding[];
}): SurvivingPairResult {
  if (!DRIVER_UUID_RE.test(input.requestedDriverId)) {
    return { ok: false, reason: 'driver_id_malformed' };
  }
  const byDriver = input.byDriver;
  const byApproved = input.byApproved;

  if (byDriver) {
    if (byDriver.driverId !== input.requestedDriverId) {
      return { ok: false, reason: 'binding_driver_mismatch' };
    }
    if (!APPROVED_KEY_RE.test(byDriver.approvedKey)) {
      return { ok: false, reason: 'approved_key_malformed' };
    }
    if (byApproved) {
      if (byApproved.driverId !== input.requestedDriverId) {
        return { ok: false, reason: 'approved_key_already_bound' };
      }
      if (byApproved.approvedKey !== byDriver.approvedKey) {
        return { ok: false, reason: 'binding_disagree' };
      }
      if (!bindingsAgree(byDriver, byApproved)) {
        return { ok: false, reason: 'binding_disagree' };
      }
      return { ok: true, surviving: byDriver, complete: true };
    }
    return { ok: true, surviving: byDriver, complete: false };
  }

  const owned = (input.byApprovedOwnedByDriver || []).filter(
    (b) => b.driverId === input.requestedDriverId,
  );
  if (owned.length === 0) return { ok: false, reason: 'binding_missing' };
  if (owned.length > 1) return { ok: false, reason: 'binding_ambiguous' };
  const only = owned[0];
  if (!APPROVED_KEY_RE.test(only.approvedKey)) {
    return { ok: false, reason: 'approved_key_malformed' };
  }
  return { ok: true, surviving: only, complete: false };
}

/**
 * Legacy login retirement. Both field proofs are required for retire AND
 * repair. A partial binding never bypasses secure-login or hydration proof.
 */
export function decideRetireLegacyLogin(input: {
  requestedDriverId: string;
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
  byApprovedOwnedByDriver?: IdentityBinding[];
  proof: IdentityProofRecord;
  approvedLegacyLoginRetired?: boolean;
}): RetireDecision {
  const pair = resolveSurvivingRetirementPair({
    requestedDriverId: input.requestedDriverId,
    byDriver: input.byDriver,
    byApproved: input.byApproved,
    byApprovedOwnedByDriver: input.byApprovedOwnedByDriver,
  });
  if (!pair.ok) return { action: 'refuse', reason: pair.reason };

  if (!secureLoginIsProven(input.proof, pair.surviving.driverId)) {
    return { action: 'refuse', reason: 'secure_login_unproven' };
  }
  if (!hydrationIsProven(input.proof, pair.surviving.driverId)) {
    return { action: 'refuse', reason: 'hydration_unproven' };
  }

  if (
    pair.complete
    && pair.surviving.status === 'legacy_login_retired'
    && input.approvedLegacyLoginRetired === true
  ) {
    return { action: 'already_retired', surviving: pair.surviving, complete: true };
  }
  if (!pair.complete) {
    return { action: 'repair', surviving: pair.surviving, complete: false };
  }
  if (pair.surviving.status === 'legacy_login_retired' && input.approvedLegacyLoginRetired !== true) {
    return { action: 'repair', surviving: pair.surviving, complete: true };
  }
  return { action: 'retire', surviving: pair.surviving, complete: true };
}

export function retirePreviewDigest(input: {
  driverId: string;
  approvedKey: string;
  survivingStatus: BindingStatus;
  survivingOpId: string;
  complete: boolean;
  secureLoginProven: boolean;
  hydrationProven: boolean;
  approvedLegacyLoginRetired: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify({
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    survivingStatus: input.survivingStatus,
    survivingOpId: input.survivingOpId,
    complete: input.complete,
    secureLoginProven: input.secureLoginProven,
    hydrationProven: input.hydrationProven,
    approvedLegacyLoginRetired: input.approvedLegacyLoginRetired,
  })).digest('hex');
}

export function evaluateRetirementPreview(input: {
  requestedDriverId: string;
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
  byApprovedOwnedByDriver?: IdentityBinding[];
  proof: IdentityProofRecord;
  approvedLegacyLoginRetired?: boolean;
}): { ok: true; decision: Exclude<RetireDecision, { action: 'refuse' }>; digest: string }
  | { ok: false; reason: string } {
  const decision = decideRetireLegacyLogin(input);
  if (decision.action === 'refuse') return { ok: false, reason: decision.reason };
  const digest = retirePreviewDigest({
    driverId: decision.surviving.driverId,
    approvedKey: decision.surviving.approvedKey,
    survivingStatus: decision.surviving.status,
    survivingOpId: decision.surviving.opId,
    complete: decision.complete,
    secureLoginProven: true,
    hydrationProven: true,
    approvedLegacyLoginRetired: input.approvedLegacyLoginRetired === true,
  });
  return { ok: true, decision, digest };
}

export function retirementTerminalAllowsApprovedStamp(input: {
  driverId: string;
  approvedKey: string;
  expectedOpId: string;
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
}): { ok: true } | { ok: false; reason: string } {
  const term = decideBindingTerminalProof({
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    byDriver: input.byDriver,
    byApproved: input.byApproved,
  });
  if (!term.ok) return term;
  if (term.binding.status !== 'legacy_login_retired') {
    return { ok: false, reason: 'binding_not_retired' };
  }
  if (term.binding.opId !== input.expectedOpId) {
    return { ok: false, reason: 'binding_op_mismatch' };
  }
  return { ok: true };
}

export function legacyLoginIsRetired(input: {
  approvedKey: string;
  approvedRow: Record<string, unknown> | null;
  byApproved: IdentityBinding | null;
}): boolean {
  if (input.byApproved?.status === 'legacy_login_retired') return true;
  if (input.approvedRow && input.approvedRow.legacyLoginRetired === true) return true;
  return false;
}

export const BINDING_ROOT = 'drivers/identityBindings';
export const BINDING_BY_DRIVER = (driverId: string) =>
  `${BINDING_ROOT}/byDriver/${driverId}`;
export const BINDING_BY_APPROVED = (approvedKey: string) =>
  `${BINDING_ROOT}/byApproved/${approvedKey}`;
export const IDENTITY_PROOF = (driverId: string) =>
  `drivers/identityProofs/${driverId}`;
