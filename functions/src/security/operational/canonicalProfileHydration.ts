/**
 * Governed copy of operational profile fields from a legacy approved row
 * onto the canonical profile. Canonical is the source of truth: a newer
 * canonical value is never overwritten silently — conflicts are previewed
 * and reported, and the canonical value is kept.
 */
import { createHash } from 'crypto';

export const OPERATIONAL_FIELDS = [
  'displayName',
  'name',
  'legalName',
  'companyId',
  'companyName',
  'assignedCustomers',
  'assignedRoutes',
  'assignedWells',
  'truckNumber',
  'trailerNumber',
  'signature',
  'language',
  'phone',
  'cdl',
  'preferredLanguage',
  'roles',
  'isAdmin',
  'isViewer',
  'active',
  'approvedAt',
  'defaultPackageId',
] as const;

export type OperationalField = (typeof OPERATIONAL_FIELDS)[number];

export interface FieldConflict {
  field: OperationalField;
  canonical: unknown;
  legacy: unknown;
  keep: 'canonical';
}

export interface HydrationPreview {
  copy: Partial<Record<OperationalField, unknown>>;
  preserved: OperationalField[];
  conflicts: FieldConflict[];
  digest: string;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Empty for copy purposes. Booleans and numbers are never empty. */
export function isAbsent(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function nestedProfile(row: Record<string, unknown>): Record<string, unknown> {
  const p = row.profile;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return p as Record<string, unknown>;
  }
  return {};
}

/**
 * Read operational fields from a legacy approved row. Nested profile/
 * values fill truck, trailer, signature, language, phone, and cdl when
 * the top-level field is absent.
 */
export function extractLegacyOperationalFields(
  row: Record<string, unknown>,
): Partial<Record<OperationalField, unknown>> {
  const nested = nestedProfile(row);
  const out: Partial<Record<OperationalField, unknown>> = {};
  for (const field of OPERATIONAL_FIELDS) {
    if (!isAbsent(row[field])) {
      out[field] = row[field];
    } else if (!isAbsent(nested[field])) {
      out[field] = nested[field];
    }
  }
  return out;
}

export function extractCanonicalOperationalFields(
  profile: Record<string, unknown>,
): Partial<Record<OperationalField, unknown>> {
  const nested = nestedProfile(profile);
  const out: Partial<Record<OperationalField, unknown>> = {};
  for (const field of OPERATIONAL_FIELDS) {
    if (!isAbsent(profile[field])) {
      out[field] = profile[field];
    } else if (!isAbsent(nested[field])) {
      out[field] = nested[field];
    }
  }
  return out;
}

export function previewCanonicalHydration(
  canonical: Record<string, unknown> | null | undefined,
  legacyRow: Record<string, unknown>,
): HydrationPreview {
  const current = extractCanonicalOperationalFields(canonical && typeof canonical === 'object' ? canonical : {});
  const legacy = extractLegacyOperationalFields(legacyRow);
  const copy: Partial<Record<OperationalField, unknown>> = {};
  const preserved: OperationalField[] = [];
  const conflicts: FieldConflict[] = [];

  for (const field of OPERATIONAL_FIELDS) {
    const c = current[field];
    const l = legacy[field];
    if (isAbsent(l)) {
      if (!isAbsent(c)) preserved.push(field);
      continue;
    }
    if (isAbsent(c)) {
      copy[field] = l;
      continue;
    }
    if (sameJson(c, l)) {
      preserved.push(field);
      continue;
    }
    conflicts.push({ field, canonical: c, legacy: l, keep: 'canonical' });
    preserved.push(field);
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({ copy, conflicts, preserved }))
    .digest('hex');

  return { copy, preserved, conflicts, digest };
}

/**
 * Apply the preview onto the canonical profile. Conflicts keep canonical.
 * Never writes approvedKey / migratedToDriverId / legacyHash onto the
 * profile (those are binding-store concerns).
 */
export function applyHydrationCopy(
  canonical: Record<string, unknown> | null | undefined,
  preview: HydrationPreview,
): Record<string, unknown> {
  const base: Record<string, unknown> = canonical && typeof canonical === 'object'
    ? { ...canonical }
    : {};
  delete base.approvedKey;
  delete base.legacyHash;
  delete base.legacyApprovedKey;

  const nested = nestedProfile(base);
  const nextNested: Record<string, unknown> = { ...nested };

  for (const [field, value] of Object.entries(preview.copy)) {
    base[field] = value;
    if (
      field === 'signature'
      || field === 'truckNumber'
      || field === 'trailerNumber'
      || field === 'language'
      || field === 'phone'
      || field === 'cdl'
      || field === 'preferredLanguage'
    ) {
      nextNested[field] = value;
    }
  }

  if (typeof base.displayName === 'string') nextNested.displayName = base.displayName;
  if (typeof base.legalName === 'string') nextNested.legalName = base.legalName;

  base.profile = nextNested;
  base.mustUseSecureAuth = true;
  if (base.schemaVersion == null) base.schemaVersion = 1;
  return base;
}

export function profileContainsForbiddenLegacyKey(
  profile: Record<string, unknown>,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(profile, 'approvedKey')
    || Object.prototype.hasOwnProperty.call(profile, 'legacyHash')
    || Object.prototype.hasOwnProperty.call(profile, 'legacyApprovedKey')
  );
}

export function projectDriverHydration(input: {
  driverId: string;
  profile: Record<string, unknown>;
  trustedHistoryDriverIds: string[];
}): Record<string, unknown> {
  const p = input.profile;
  const nested = nestedProfile(p);
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null;
  return {
    driverId: input.driverId,
    displayName: str(p.displayName) || str(nested.displayName) || '',
    legalName: str(p.legalName) || str(nested.legalName),
    name: str(p.name),
    companyId: str(p.companyId) || str(nested.companyId),
    companyName: str(p.companyName) || str(nested.companyName),
    assignedCustomers: Array.isArray(p.assignedCustomers) ? p.assignedCustomers : [],
    assignedRoutes: Array.isArray(p.assignedRoutes) ? p.assignedRoutes : null,
    assignedWells: Array.isArray(p.assignedWells) ? p.assignedWells : null,
    truckNumber: str(p.truckNumber) || str(nested.truckNumber),
    trailerNumber: str(p.trailerNumber) || str(nested.trailerNumber),
    signature: str(p.signature) || str(nested.signature),
    language: str(p.language) || str(nested.language) || str(p.preferredLanguage),
    phone: str(p.phone) || str(nested.phone),
    cdl: str(p.cdl) || str(nested.cdl),
    isAdmin: p.isAdmin === true,
    isViewer: p.isViewer === true,
    roles: Array.isArray(p.roles) ? p.roles : ['driver'],
    logoutAt: p.logoutAt ?? nested.logoutAt ?? null,
    trustedHistoryDriverIds: [...input.trustedHistoryDriverIds],
  };
}
