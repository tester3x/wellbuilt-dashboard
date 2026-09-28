/**
 * Canonical equipment-assignment identity.
 *
 * The assignment field is `driverId`: the authenticated driver's canonical
 * UUID. A passcode hash, approved key, or client alias is not that id and
 * is not queried. Hash-only development rows stay invisible.
 */
import { DRIVER_UUID_RE } from '../security/operational/identityBinding';
import type { Assignment } from './types/assignment';

export const ASSIGNMENT_DRIVER_FIELD = 'driverId' as const;

const FORBIDDEN_ALIAS_KEYS = [
  'driverHash',
  'approvedKey',
  'legacyHash',
  'legacyKey',
  'historyKeys',
  'historyAliases',
  'trustedHistoryDriverIds',
  'alias',
  'aliases',
] as const;

export function isCanonicalDriverId(value: unknown): value is string {
  return typeof value === 'string' && DRIVER_UUID_RE.test(value);
}

export function clientAliasKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const body = payload as Record<string, unknown>;
  return FORBIDDEN_ALIAS_KEYS.filter((key) => body[key] !== undefined);
}

export interface AssignmentAuthority {
  active: boolean;
  companyId: string;
}

export type AssignmentSubjectResult =
  | { ok: true; driverId: string; companyId: string }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' | 'malformed' | 'inactive' | 'cross_company' };

/**
 * Driver calls use the Auth claim only. Dashboard calls may name a driverId,
 * which is then checked against current server authority for that company.
 */
export async function resolveAssignmentSubject(input: {
  mode: 'driver' | 'dashboard';
  companyId: string;
  token?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  loadAuthority(driverId: string): Promise<AssignmentAuthority | null>;
}): Promise<AssignmentSubjectResult> {
  if (clientAliasKeys(input.payload).length > 0) return { ok: false, reason: 'malformed' };
  if (!input.companyId.trim()) return { ok: false, reason: 'malformed' };

  let driverId = '';
  if (input.mode === 'driver') {
    const token = input.token || {};
    if (token.kind !== 'driver' || !isCanonicalDriverId(token.driverId)) {
      return { ok: false, reason: 'unauthenticated' };
    }
    driverId = token.driverId;
    if (typeof token.companyId === 'string' && token.companyId.trim() && token.companyId.trim() !== input.companyId) {
      return { ok: false, reason: 'cross_company' };
    }
    if (input.payload.driverId !== undefined && input.payload.driverId !== driverId) {
      return { ok: false, reason: 'forbidden' };
    }
  } else {
    if (!isCanonicalDriverId(input.payload.driverId)) return { ok: false, reason: 'malformed' };
    driverId = input.payload.driverId;
  }

  const authority = await input.loadAuthority(driverId);
  if (!authority?.companyId) return { ok: false, reason: 'forbidden' };
  if (!authority.active) return { ok: false, reason: 'inactive' };
  if (authority.companyId !== input.companyId) return { ok: false, reason: 'cross_company' };
  return { ok: true, driverId, companyId: authority.companyId };
}

/** Hash-only rows are not canonical assignments. */
export function canonicalAssignmentFromData(data: unknown): Assignment | null {
  if (!data || typeof data !== 'object') return null;
  const row = data as Assignment & { driverHash?: string };
  if (!isCanonicalDriverId(row.driverId)) return null;
  if (row.driverHash !== undefined) return null;
  return row;
}

export function equipmentIdForCanonicalAssignment(
  data: unknown,
  driverId: string,
): string | null {
  const row = canonicalAssignmentFromData(data);
  if (!row || row.driverId !== driverId || row.active !== true) return null;
  return typeof row.equipmentId === 'string' && row.equipmentId ? row.equipmentId : null;
}
