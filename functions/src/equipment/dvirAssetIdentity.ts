/**
 * Pure resolver from trusted server lookups to canonical equipment ids.
 *
 * Company and driver come only from `authority`. A typed unit is a lookup
 * key, not an id. Equipment's `truck_<unit>` / `trailer_<unit>` strings are
 * a different namespace and are never returned as canonical ids.
 *
 * This does not decide inspection coverage and does not satisfy Start Job.
 * `startJobSatisfied` is always false. An empty request means no roles were
 * asked about, which is the same idea as `evaluateDvirAssetCoverage` with
 * `assets: []`: nothing requested, not a passed gate.
 *
 * Off-shift and company-tier policy are not decided. Unavailable authority
 * yields `unavailable` per role.
 */

export type DvirAssetRole = 'truck' | 'trailer';

export type IdentityAuthority =
  | { state: 'open'; companyId: string; driverId: string }
  | { state: 'unavailable' };

/** One active assignment row already loaded for a company. */
export interface TrustedAssignmentRow {
  companyId: string;
  driverId: string;
  active: boolean;
  equipmentId: string;
  equipmentTypeId: string;
}

/** One active registry row. Callers must pass every match, not a limit(1) sample. */
export interface TrustedRegistryRow {
  companyId: string;
  active: boolean;
  equipmentId: string;
  equipmentTypeId: string;
  unitNumber: string;
}

export interface RoleLookupRequest {
  role: DvirAssetRole;
  /** Optional typed unit. Never accepted as an equipment id. */
  typedUnit?: string | null;
  /**
   * Last canonical id cached on a device. Never verified here.
   * Ignored when the server resolves or finds an ambiguity.
   */
  cachedEquipmentId?: string | null;
}

export interface DvirAssetIdentityInput {
  authority: IdentityAuthority;
  requests: readonly RoleLookupRequest[];
  assignments: readonly TrustedAssignmentRow[];
  registry: readonly TrustedRegistryRow[];
}

export type RoleResolution =
  | { role: DvirAssetRole; status: 'resolved'; equipmentId: string }
  | {
      role: DvirAssetRole;
      status: 'ambiguous';
      reason: 'multiple_assignments' | 'duplicate_units';
      matchCount: number;
    }
  | { role: DvirAssetRole; status: 'unregistered' }
  | { role: DvirAssetRole; status: 'non_canonical' }
  | { role: DvirAssetRole; status: 'cached_unverified'; equipmentId: string }
  | { role: DvirAssetRole; status: 'unavailable' };

export type DvirAssetIdentityDecision =
  | { ok: false; reason: 'malformed' }
  | {
      ok: true;
      /** Never a Start Job pass. Empty `roles` is not satisfaction either. */
      startJobSatisfied: false;
      roles: RoleResolution[];
    };

const UNIT_DERIVED_ID = /^(truck|trailer)_[a-z0-9_]+$/i;

export function isUnitDerivedEquipmentId(equipmentId: string): boolean {
  return UNIT_DERIVED_ID.test(equipmentId);
}

export function isCanonicalEquipmentId(equipmentId: unknown): boolean {
  return typeof equipmentId === 'string'
    && equipmentId.length > 0
    && equipmentId === equipmentId.trim()
    && !isUnitDerivedEquipmentId(equipmentId);
}

/** Same normalization as equipmentService.normalizeUnitNumber. */
export function normalizeUnitNumber(value: string): string {
  return value.trim().toUpperCase();
}

/** Same normalization as equipmentService.normalizeTypeId. */
export function normalizeTypeId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function isRole(value: unknown): value is DvirAssetRole {
  return value === 'truck' || value === 'trailer';
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function requestMalformed(input: DvirAssetIdentityInput): boolean {
  if (!input.authority || (input.authority.state !== 'open' && input.authority.state !== 'unavailable')) {
    return true;
  }
  if (input.authority.state === 'open') {
    if (!isNonEmpty(input.authority.companyId) || !isNonEmpty(input.authority.driverId)) return true;
  }
  if (!Array.isArray(input.requests) || !Array.isArray(input.assignments) || !Array.isArray(input.registry)) {
    return true;
  }
  const seen = new Set<DvirAssetRole>();
  for (const request of input.requests) {
    if (!request || !isRole(request.role)) return true;
    if (seen.has(request.role)) return true;
    seen.add(request.role);
  }
  return false;
}

function canonicalAssignments(
  authority: Extract<IdentityAuthority, { state: 'open' }>,
  role: DvirAssetRole,
  assignments: readonly TrustedAssignmentRow[],
): { canonical: TrustedAssignmentRow[]; sawNonCanonical: boolean } {
  const canonical: TrustedAssignmentRow[] = [];
  let sawNonCanonical = false;
  for (const row of assignments) {
    if (!row || row.active !== true) continue;
    if (row.companyId !== authority.companyId || row.driverId !== authority.driverId) continue;
    if (normalizeTypeId(String(row.equipmentTypeId || '')) !== role) continue;
    if (isUnitDerivedEquipmentId(row.equipmentId.trim())) sawNonCanonical = true;
    else if (isCanonicalEquipmentId(row.equipmentId)) canonical.push(row);
  }
  return { canonical, sawNonCanonical };
}

function registryMatches(
  authority: Extract<IdentityAuthority, { state: 'open' }>,
  role: DvirAssetRole,
  typedUnit: string,
  registry: readonly TrustedRegistryRow[],
): { canonicalIds: string[]; sawNonCanonical: boolean } {
  const wanted = normalizeUnitNumber(typedUnit);
  const ids = new Set<string>();
  let sawNonCanonical = false;
  for (const row of registry) {
    if (!row || row.active !== true) continue;
    if (row.companyId !== authority.companyId) continue;
    if (normalizeTypeId(String(row.equipmentTypeId || '')) !== role) continue;
    if (!isNonEmpty(row.unitNumber) || normalizeUnitNumber(row.unitNumber) !== wanted) continue;
    if (isUnitDerivedEquipmentId(row.equipmentId.trim())) sawNonCanonical = true;
    else if (isCanonicalEquipmentId(row.equipmentId)) ids.add(row.equipmentId);
  }
  return { canonicalIds: [...ids], sawNonCanonical };
}

function cachedCanonical(request: RoleLookupRequest): string | null {
  const id = request.cachedEquipmentId;
  return typeof id === 'string' && isCanonicalEquipmentId(id) ? id : null;
}

function resolveRole(
  authority: IdentityAuthority,
  request: RoleLookupRequest,
  assignments: readonly TrustedAssignmentRow[],
  registry: readonly TrustedRegistryRow[],
): RoleResolution {
  if (authority.state !== 'open') return { role: request.role, status: 'unavailable' };
  const { canonical, sawNonCanonical } = canonicalAssignments(authority, request.role, assignments);
  const distinct = [...new Set(canonical.map((row) => row.equipmentId))];
  if (distinct.length > 1) {
    return {
      role: request.role,
      status: 'ambiguous',
      reason: 'multiple_assignments',
      matchCount: distinct.length,
    };
  }
  if (distinct.length === 1) {
    return { role: request.role, status: 'resolved', equipmentId: distinct[0] };
  }
  if (sawNonCanonical) return { role: request.role, status: 'non_canonical' };

  const typed = typeof request.typedUnit === 'string' ? request.typedUnit.trim() : '';
  if (!typed) {
    const cached = cachedCanonical(request);
    return cached
      ? { role: request.role, status: 'cached_unverified', equipmentId: cached }
      : { role: request.role, status: 'unregistered' };
  }
  const found = registryMatches(authority, request.role, typed, registry);
  if (found.canonicalIds.length > 1) {
    return {
      role: request.role,
      status: 'ambiguous',
      reason: 'duplicate_units',
      matchCount: found.canonicalIds.length,
    };
  }
  if (found.canonicalIds.length === 1) {
    return { role: request.role, status: 'resolved', equipmentId: found.canonicalIds[0] };
  }
  if (found.sawNonCanonical) return { role: request.role, status: 'non_canonical' };
  const cached = cachedCanonical(request);
  return cached
    ? { role: request.role, status: 'cached_unverified', equipmentId: cached }
    : { role: request.role, status: 'unregistered' };
}

export function resolveDvirAssetIdentity(input: DvirAssetIdentityInput): DvirAssetIdentityDecision {
  if (requestMalformed(input)) return { ok: false, reason: 'malformed' };
  return {
    ok: true,
    startJobSatisfied: false,
    roles: input.requests.map((request) =>
      resolveRole(input.authority, request, input.assignments, input.registry)),
  };
}
