/**
 * Fail-closed ownership / company decisions. Missing IDs are never equal.
 */
export type OwnershipRefuse =
  | 'missing_owner'
  | 'missing_company'
  | 'not_owner'
  | 'cross_company'
  | 'unscoped_resource'
  | 'not_member';

export function sameId(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a === b;
}

export function decideResourceOwnership(input: {
  callerDriverId: string;
  callerCompanyId: string;
  resourceDriverId?: unknown;
  resourceCompanyId?: unknown;
  isManager?: boolean;
}): { ok: true } | { ok: false; reason: OwnershipRefuse } {
  if (typeof input.resourceCompanyId !== 'string' || !input.resourceCompanyId) {
    return { ok: false, reason: 'unscoped_resource' };
  }
  if (!sameId(input.resourceCompanyId, input.callerCompanyId)) {
    return { ok: false, reason: 'cross_company' };
  }
  if (input.isManager) return { ok: true };
  if (typeof input.resourceDriverId !== 'string' || !input.resourceDriverId) {
    return { ok: false, reason: 'missing_owner' };
  }
  if (!sameId(input.resourceDriverId, input.callerDriverId)) {
    return { ok: false, reason: 'not_owner' };
  }
  return { ok: true };
}

export function decideThreadMembership(input: {
  callerDriverId: string;
  callerCompanyId: string;
  threadCompanyId?: unknown;
  participantIds?: unknown;
  isManager?: boolean;
}): { ok: true } | { ok: false; reason: OwnershipRefuse } {
  if (typeof input.threadCompanyId !== 'string' || !input.threadCompanyId) {
    return { ok: false, reason: 'unscoped_resource' };
  }
  if (!sameId(input.threadCompanyId, input.callerCompanyId)) {
    return { ok: false, reason: 'cross_company' };
  }
  if (input.isManager) return { ok: true };
  const parts = Array.isArray(input.participantIds) ? input.participantIds.map(String) : [];
  if (!parts.includes(input.callerDriverId)) {
    return { ok: false, reason: 'not_member' };
  }
  return { ok: true };
}
