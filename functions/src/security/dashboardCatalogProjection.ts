/**
 * Allowlisted, caller-scoped projection of the Dashboard admin catalog.
 * Admin SDK parent reads stay intact; this layer never returns raw trees,
 * passcodes, hashes, tokens, or records outside the caller's company.
 */
import type { DashboardCaller } from './adminAuth';

export const APPROVED_ALLOWLIST = [
  'displayName',
  'name',
  'legalName',
  'active',
  'isAdmin',
  'isViewer',
  'companyId',
  'companyName',
  'assignedCustomers',
  'assignedRoutes',
  'assignedWells',
  'defaultPackageId',
  'dashboardUid',
  'dashboardRole',
  'driverId',
  'migratedToDriverId',
  'profile',
] as const;

export const PROFILE_ALLOWLIST = [
  'displayName',
  'legalName',
  'phone',
  'companyId',
  'companyName',
] as const;

export const USER_ALLOWLIST = [
  'email',
  'displayName',
  'role',
  'roles',
  'companyId',
  'companyName',
  'driverHash',
] as const;

export const WELL_CONFIG_ALLOWLIST = [
  'route',
  'maxLevel',
  'bottomLevel',
  'tanks',
  'numTanks',
  'pullBbls',
  'tankCapacity',
  'tankHeight',
  'bblPerFoot',
  'allowedBottom',
  'ndicName',
  'ndicApiNo',
  'avgFlowRate',
  'avgFlowRateMinutes',
  'waterWeight',
  'h2sStatus',
  'routeRecording',
  'routeGroupWell',
  'companyId',
] as const;

const SENSITIVE_KEYS = new Set([
  'passcode',
  'passcodehash',
  'password',
  'passwordhash',
  'passwd',
  'token',
  'refreshtoken',
  'idtoken',
  'accesstoken',
  'customtoken',
  'fcmtoken',
  'pushtoken',
  'authtoken',
  'sessiontoken',
  'session',
  'sessionid',
  'secret',
  'apikey',
  'privatekey',
  'credential',
  'pin',
  'pinhash',
]);

export type CatalogScope = 'platform' | 'company';

export type ProjectedDashboardCatalog = {
  scope: CatalogScope;
  companyId: string | null;
  approved: Record<string, Record<string, unknown>>;
  users: Record<string, Record<string, unknown>>;
  wellConfig: Record<string, Record<string, unknown>>;
  counts: { approved: number; users: number; wellConfig: number };
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function isSensitiveCatalogKey(key: string): boolean {
  const k = key.toLowerCase();
  if (k === 'driverhash') return false;
  if (SENSITIVE_KEYS.has(k)) return true;
  return /passcode|password|(^|_)token|session|secret|privatekey|credential/.test(k);
}

function pickAllowlisted(
  record: Record<string, unknown>,
  allow: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (!(key in record)) continue;
    if (isSensitiveCatalogKey(key)) continue;
    const val = record[key];
    if (key === 'profile' && val && typeof val === 'object' && !Array.isArray(val)) {
      out.profile = pickAllowlisted(asRecord(val), PROFILE_ALLOWLIST);
      continue;
    }
    out[key] = val;
  }
  for (const key of Object.keys(out)) {
    if (isSensitiveCatalogKey(key)) delete out[key];
  }
  return out;
}

function recordCompanyId(record: Record<string, unknown>): string {
  if (typeof record.companyId === 'string' && record.companyId.trim()) {
    return record.companyId.trim();
  }
  const profile = asRecord(record.profile);
  if (typeof profile.companyId === 'string' && profile.companyId.trim()) {
    return profile.companyId.trim();
  }
  return '';
}

function belongsToCompany(record: Record<string, unknown>, companyId: string): boolean {
  return recordCompanyId(record) === companyId;
}

function flattenApprovedEntry(val: unknown): Record<string, unknown> | null {
  const rec = asRecord(val);
  if (typeof rec.displayName === 'string' || typeof rec.name === 'string') {
    return pickAllowlisted(rec, APPROVED_ALLOWLIST);
  }
  for (const child of Object.values(rec)) {
    const nested = asRecord(child);
    if (typeof nested.displayName === 'string' || typeof nested.name === 'string') {
      return pickAllowlisted(
        {
          ...nested,
          companyId: nested.companyId ?? rec.companyId,
          companyName: nested.companyName ?? rec.companyName,
        },
        APPROVED_ALLOWLIST,
      );
    }
  }
  return null;
}

function projectMap(
  raw: unknown,
  projectOne: (val: unknown) => Record<string, unknown> | null,
  companyId: string | null,
): Record<string, Record<string, unknown>> {
  const source = asRecord(raw);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, val] of Object.entries(source)) {
    const projected = projectOne(val);
    if (!projected) continue;
    if (companyId && !belongsToCompany(projected, companyId)) continue;
    out[key] = projected;
  }
  return out;
}

export function projectDashboardCatalog(input: {
  approved: unknown;
  users: unknown;
  wellConfig: unknown;
  caller: Pick<DashboardCaller, 'companyId' | 'isPlatformAdmin'>;
}): ProjectedDashboardCatalog {
  const scope: CatalogScope = input.caller.isPlatformAdmin ? 'platform' : 'company';
  const companyId = input.caller.isPlatformAdmin
    ? null
    : (typeof input.caller.companyId === 'string' ? input.caller.companyId.trim() : '');
  const filterCompany = scope === 'company' ? (companyId || '__none__') : null;

  const approved = projectMap(input.approved, flattenApprovedEntry, filterCompany);
  const users = projectMap(
    input.users,
    (val) => pickAllowlisted(asRecord(val), USER_ALLOWLIST),
    filterCompany,
  );
  const wellConfig = projectMap(
    input.wellConfig,
    (val) => pickAllowlisted(asRecord(val), WELL_CONFIG_ALLOWLIST),
    filterCompany,
  );

  return {
    scope,
    companyId: scope === 'company' ? (companyId || null) : null,
    approved,
    users,
    wellConfig,
    counts: {
      approved: Object.keys(approved).length,
      users: Object.keys(users).length,
      wellConfig: Object.keys(wellConfig).length,
    },
  };
}
