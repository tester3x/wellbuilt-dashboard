/**
 * addSplitLeg authorization — decided before any write construction.
 * Hash/client owner fields are never authority.
 */
import { staffHasCapability, type AdminAuthority } from '../canonicalAdminAuthority';
import { decideResourceOwnership } from './resourceOwnership';

export const SPLIT_STAFF_CAPABILITY = 'createDispatch' as const;

export type SplitCaller =
  | { class: 'driver'; uid: string; driverId: string; companyId: string }
  | { class: 'staff'; uid: string; companyId: string; caps: string[] }
  | { class: 'platform'; uid: string };

export type SplitParentView = {
  companyId?: unknown;
  driverId?: unknown;
  assignedDriverId?: unknown;
  splitGroupId?: unknown;
};

export type SplitAuthRefuse =
  | 'unauthenticated'
  | 'not_authorized'
  | 'missing_capability'
  | 'unscoped_resource'
  | 'no_split_chain'
  | 'missing_owner'
  | 'missing_company'
  | 'not_owner'
  | 'cross_company'
  | 'not_member';

export function parentOwnerId(
  parent: SplitParentView,
  serverMappedOwnerId?: string | null,
): string | null {
  if (typeof parent.driverId === 'string' && parent.driverId.trim()) return parent.driverId.trim();
  if (typeof parent.assignedDriverId === 'string' && parent.assignedDriverId.trim()) {
    return parent.assignedDriverId.trim();
  }
  if (typeof serverMappedOwnerId === 'string' && serverMappedOwnerId.trim()) {
    return serverMappedOwnerId.trim();
  }
  return null;
}

export function decideAddSplitLegAuthority(input: {
  caller: SplitCaller | null;
  parent: SplitParentView | null;
  serverMappedOwnerId?: string | null;
}): { ok: true; via: SplitCaller['class'] } | { ok: false; reason: SplitAuthRefuse } {
  if (!input.caller) return { ok: false, reason: 'unauthenticated' };
  if (!input.parent) return { ok: false, reason: 'unscoped_resource' };
  if (typeof input.parent.splitGroupId !== 'string' || !input.parent.splitGroupId.trim()) {
    return { ok: false, reason: 'no_split_chain' };
  }
  if (typeof input.parent.companyId !== 'string' || !input.parent.companyId.trim()) {
    return { ok: false, reason: 'unscoped_resource' };
  }

  if (input.caller.class === 'platform') return { ok: true, via: 'platform' };

  if (input.caller.class === 'staff') {
    if (!input.caller.caps.includes(SPLIT_STAFF_CAPABILITY)) {
      return { ok: false, reason: 'missing_capability' };
    }
    if (input.caller.companyId !== input.parent.companyId) {
      return { ok: false, reason: 'cross_company' };
    }
    return { ok: true, via: 'staff' };
  }

  const ownerId = parentOwnerId(input.parent, input.serverMappedOwnerId);
  const own = decideResourceOwnership({
    callerDriverId: input.caller.driverId,
    callerCompanyId: input.caller.companyId,
    resourceDriverId: ownerId,
    resourceCompanyId: input.parent.companyId,
  });
  if (!own.ok) return { ok: false, reason: own.reason };
  return { ok: true, via: 'driver' };
}

export function staffCallerFromAuthority(
  authority: Extract<AdminAuthority, { ok: true }>,
): SplitCaller | null {
  if (authority.class === 'platform') return { class: 'platform', uid: authority.uid };
  if (!authority.companyId) return null;
  if (!staffHasCapability(authority, SPLIT_STAFF_CAPABILITY)) {
    return { class: 'staff', uid: authority.uid, companyId: authority.companyId, caps: authority.caps };
  }
  return { class: 'staff', uid: authority.uid, companyId: authority.companyId, caps: authority.caps };
}

export function splitAttemptKey(input: {
  uid: string;
  splitGroupId: string;
  parentDispatchId: string;
  disposal: string;
}): string {
  const disposal = input.disposal.trim().toLowerCase();
  return [input.uid, input.splitGroupId, input.parentDispatchId, disposal].join('|');
}
