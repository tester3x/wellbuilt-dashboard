/**
 * Authenticated read-only truck/trailer identity lookup.
 *
 * Company and driver come from the verified driver Auth claim plus
 * `loadCanonicalDriverAuthority`. Client company, driver, equipment id,
 * `verified`, period, and assignment rows are not authority.
 *
 * This does not decide whether a DVIR is required, completed, or enough
 * for Start Job. `startJobSatisfied` is always false.
 */
import * as admin from 'firebase-admin';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../../security/canonicalDriverAuthority';
import {
  normalizeTypeId,
  normalizeUnitNumber,
  resolveDvirAssetIdentity,
  type DvirAssetRole,
  type RoleLookupRequest,
  type RoleResolution,
  type TrustedAssignmentRow,
  type TrustedRegistryRow,
} from '../dvirAssetIdentity';
import { equipmentIdForCanonicalAssignment } from '../assignmentIdentity';
import { assignmentsCollection } from '../types/assignment';
import { Equipment, equipmentCollection } from '../types/equipment';

const ASSIGNMENT_CAP = 50;
const UNIT_CAP = 25;

const FORBIDDEN_KEYS = [
  'companyId', 'driverHash', 'driverId', 'equipmentId', 'verified',
  'periodId', 'assignment', 'assignments', 'cachedEquipmentId', 'unitNumber',
];

export interface IdentityLookupAuth {
  uid?: string | null;
  token?: Record<string, unknown> | null;
}

export interface IdentityLookupIo {
  loadAuthority(driverId: string): Promise<{ active: boolean; companyId: string } | null>;
  listActiveAssignments(companyId: string, driverId: string): Promise<{
    rows: Array<{ equipmentId: string }>;
    truncated: boolean;
  }>;
  loadEquipment(companyId: string, equipmentId: string): Promise<{
    equipmentId: string;
    companyId: string;
    equipmentTypeId: string;
    unitNumber: string;
    active: boolean;
  } | null>;
  listActiveByTypeAndUnit(companyId: string, equipmentTypeId: string, unitNumber: string): Promise<{
    rows: Array<{ equipmentId: string; equipmentTypeId: string; unitNumber: string }>;
    truncated: boolean;
  }>;
}

export type LookupRoleResult =
  | RoleResolution
  | { role: DvirAssetRole; status: 'unresolved'; reason: 'query_truncated' | 'assignment_unusable' };

export type IdentityLookupResponse =
  | { ok: false; reason: 'unauthenticated' | 'forbidden' | 'malformed' | 'lookup_failed' }
  | { ok: true; startJobSatisfied: false; roles: LookupRoleResult[] };

function isRole(value: unknown): value is DvirAssetRole {
  return value === 'truck' || value === 'trailer';
}

export function parseIdentityLookupRequests(payload: unknown): RoleLookupRequest[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  if (Object.keys(body).some((key) => FORBIDDEN_KEYS.includes(key))) return null;
  if (!('requests' in body)) return null;
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length > 2) return null;
  const parsed: RoleLookupRequest[] = [];
  const seen = new Set<DvirAssetRole>();
  for (const entry of requests) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== 'role' && key !== 'typedUnit')) return null;
    if (!isRole(row.role) || seen.has(row.role)) return null;
    seen.add(row.role);
    if (row.typedUnit !== undefined && row.typedUnit !== null) {
      if (typeof row.typedUnit !== 'string' || row.typedUnit.trim().length > 64) return null;
      parsed.push({ role: row.role, typedUnit: row.typedUnit });
    } else {
      parsed.push({ role: row.role });
    }
  }
  return parsed;
}

function unresolved(role: DvirAssetRole, reason: 'query_truncated' | 'assignment_unusable'): LookupRoleResult {
  return { role, status: 'unresolved', reason };
}

export async function lookupDvirAssetIdentity(input: {
  auth: IdentityLookupAuth;
  payload: unknown;
  io: IdentityLookupIo;
}): Promise<IdentityLookupResponse> {
  if (!input.auth.uid) return { ok: false, reason: 'unauthenticated' };
  const token = input.auth.token || {};
  if (token.kind !== 'driver' || typeof token.driverId !== 'string' || !token.driverId.trim()) {
    return { ok: false, reason: 'forbidden' };
  }
  const requests = parseIdentityLookupRequests(input.payload);
  if (!requests) return { ok: false, reason: 'malformed' };

  let principal: { active: boolean; companyId: string } | null;
  try {
    principal = await input.io.loadAuthority(token.driverId.trim());
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (!principal?.active || !principal.companyId) return { ok: false, reason: 'forbidden' };
  if (typeof token.companyId === 'string' && token.companyId.trim()
    && token.companyId.trim() !== principal.companyId) {
    return { ok: false, reason: 'forbidden' };
  }
  if (requests.length === 0) return { ok: true, startJobSatisfied: false, roles: [] };

  let assignments: { rows: Array<{ equipmentId: string }>; truncated: boolean };
  try {
    assignments = await input.io.listActiveAssignments(principal.companyId, token.driverId.trim());
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (assignments.truncated) {
    return {
      ok: true,
      startJobSatisfied: false,
      roles: requests.map((request) => unresolved(request.role, 'query_truncated')),
    };
  }

  const trustedAssignments: TrustedAssignmentRow[] = [];
  let unattributable = false;
  const unusableRoles = new Set<DvirAssetRole>();
  try {
    for (const assignment of assignments.rows) {
      if (!assignment.equipmentId) {
        unattributable = true;
        continue;
      }
      const equipment = await input.io.loadEquipment(principal.companyId, assignment.equipmentId);
      if (!equipment || equipment.companyId !== principal.companyId
        || !equipment.equipmentTypeId || !equipment.equipmentId) {
        unattributable = true;
        continue;
      }
      if (equipment.active !== true) {
        const typeId = normalizeTypeId(equipment.equipmentTypeId);
        if (typeId === 'truck' || typeId === 'trailer') unusableRoles.add(typeId);
        continue;
      }
      trustedAssignments.push({
        companyId: principal.companyId,
        driverId: token.driverId.trim(),
        active: true,
        equipmentId: equipment.equipmentId,
        equipmentTypeId: equipment.equipmentTypeId,
      });
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (unattributable) {
    return {
      ok: true,
      startJobSatisfied: false,
      roles: requests.map((request) => unresolved(request.role, 'assignment_unusable')),
    };
  }

  const registry: TrustedRegistryRow[] = [];
  const truncatedRoles = new Set<DvirAssetRole>();
  try {
    for (const request of requests) {
      if (unusableRoles.has(request.role)) continue;
      const hasAssignment = trustedAssignments.some((row) =>
        normalizeTypeId(row.equipmentTypeId) === request.role);
      const typed = request.typedUnit?.trim();
      if (hasAssignment || !typed) continue;
      const found = await input.io.listActiveByTypeAndUnit(
        principal.companyId,
        request.role,
        normalizeUnitNumber(typed),
      );
      if (found.truncated) {
        truncatedRoles.add(request.role);
        continue;
      }
      for (const row of found.rows) {
        registry.push({
          companyId: principal.companyId,
          active: true,
          equipmentId: row.equipmentId,
          equipmentTypeId: row.equipmentTypeId,
          unitNumber: row.unitNumber,
        });
      }
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }

  const resolvable = requests.filter((request) =>
    !unusableRoles.has(request.role) && !truncatedRoles.has(request.role));
  const resolved = resolveDvirAssetIdentity({
    authority: { state: 'open', companyId: principal.companyId, driverId: token.driverId.trim() },
    requests: resolvable,
    assignments: trustedAssignments,
    registry,
  });
  if (!resolved.ok) return { ok: false, reason: 'malformed' };

  const byRole = new Map(resolved.roles.map((role) => [role.role, role]));
  return {
    ok: true,
    startJobSatisfied: false,
    roles: requests.map((request) => {
      if (truncatedRoles.has(request.role)) return unresolved(request.role, 'query_truncated');
      if (unusableRoles.has(request.role)) return unresolved(request.role, 'assignment_unusable');
      return byRole.get(request.role) || unresolved(request.role, 'assignment_unusable');
    }),
  };
}

function equipmentView(companyId: string, data: Equipment, id: string) {
  return {
    equipmentId: data.equipmentId || id,
    companyId: data.companyId || companyId,
    equipmentTypeId: data.equipmentTypeId,
    unitNumber: data.unitNumber,
    active: data.active === true,
  };
}

/** Reads used by the callable. No writes. Does not use registry.resolveByUnit. */
export function productionIdentityLookupIo(): IdentityLookupIo {
  const firestore = admin.firestore();
  return {
    async loadAuthority(driverId) {
      const loaded = await loadCanonicalDriverAuthority(driverId, productionCanonicalDriverReaders());
      if (!loaded?.active || !loaded.companyId) return null;
      return { active: loaded.active, companyId: loaded.companyId };
    },
    async listActiveAssignments(companyId, driverId) {
      const snap = await firestore.collection(assignmentsCollection(companyId))
        .where('driverId', '==', driverId)
        .where('active', '==', true)
        .limit(ASSIGNMENT_CAP + 1)
        .get();
      return {
        truncated: snap.size > ASSIGNMENT_CAP,
        rows: snap.docs.slice(0, ASSIGNMENT_CAP).flatMap((doc) => {
          const equipmentId = equipmentIdForCanonicalAssignment(doc.data(), driverId);
          return equipmentId ? [{ equipmentId }] : [];
        }),
      };
    },
    async loadEquipment(companyId, equipmentId) {
      const snap = await firestore.collection(equipmentCollection(companyId)).doc(equipmentId).get();
      if (!snap.exists) return null;
      return equipmentView(companyId, snap.data() as Equipment, snap.id);
    },
    async listActiveByTypeAndUnit(companyId, equipmentTypeId, unitNumber) {
      const snap = await firestore.collection(equipmentCollection(companyId))
        .where('equipmentTypeId', '==', equipmentTypeId)
        .where('unitNumber', '==', unitNumber)
        .where('active', '==', true)
        .limit(UNIT_CAP + 1)
        .get();
      return {
        truncated: snap.size > UNIT_CAP,
        rows: snap.docs.slice(0, UNIT_CAP).map((doc) => {
          const data = doc.data() as Equipment;
          return {
            equipmentId: data.equipmentId || doc.id,
            equipmentTypeId: data.equipmentTypeId,
            unitNumber: data.unitNumber,
          };
        }),
      };
    },
  };
}
