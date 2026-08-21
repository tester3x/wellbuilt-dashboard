/**
 * Allowlisted, caller-scoped projection of the Dashboard admin catalog.
 * Admin SDK parent reads stay intact; this layer never returns raw trees,
 * passcodes, hashes, tokens, or records outside the caller's company.
 *
 * well_config is Liquid Gold's global operational pool (most records have
 * no companyId). It is NOT tenant-filtered like employees/users. The
 * existing canViewGlobalWellPool policy applies:
 *   platform / unscoped → full pool
 *   liquid-gold         → full pool, including unscoped records
 *   any other company   → no wellConfig / wellStatus
 */
import type { DashboardCaller } from './adminAuth';

export const LEGACY_WELL_POOL_COMPANY_ID = 'liquid-gold';

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

/** Canonical drivers/profiles fields for WB-M administration. */
export const CANONICAL_PROFILE_ALLOWLIST = [
  'displayName',
  'legalName',
  'name',
  'phone',
  'companyId',
  'companyName',
  'active',
  'roles',
  'isAdmin',
  'isViewer',
  'assignedRoutes',
  'assignedWells',
  'assignmentRevision',
  'assignmentUpdatedAt',
  'mustUseSecureAuth',
  'schemaVersion',
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

export const PENDING_ALLOWLIST = [
  'displayName',
  'legalName',
  'companyId',
  'companyName',
  'requestedAt',
  'timestamp',
  'status',
  'securePendingId',
] as const;

/**
 * Production well_config field contract (2026-08-21 inventory of 82 wells).
 * Operational display/edit fields must not be silently dropped.
 */
export const WELL_CONFIG_ALLOWLIST = [
  'route',
  'routeColor',
  'maxLevel',
  'bottomLevel',
  'tanks',
  'numTanks',
  'activeTanks',
  'equalizedTanks',
  'pullBbls',
  'tankCapacity',
  'tankHeight',
  'bblPerFoot',
  'allowedBottom',
  'requireActualBottom',
  'ndicName',
  'ndicApiNo',
  'avgFlowRate',
  'avgFlowRateMinutes',
  'waterWeight',
  'h2sStatus',
  'isDown',
  'loadLine',
  'routeRecording',
  'routeGroupWell',
  'companyId',
] as const;

/** Bounded live-status fields from packets/outgoing. Never a raw packet tree. */
export const WELL_STATUS_ALLOWLIST = [
  'wellName',
  'currentLevel',
  'status',
  'timestamp',
  'timestampUTC',
  'flowRate',
  'timeTillPull',
  'nextPullTime',
  'nextPullTimeUTC',
  'wellDown',
  'isDown',
  'lastPullDateTime',
  'lastPullDateTimeUTC',
  'lastPullBbls',
  'lastPullBottomLevel',
  'lastPullTopLevel',
  'lastPullDriverName',
  'bbls24hrs',
  'windowBblsDay',
  'overnightBblsDay',
  'tanks',
  'pullBbls',
  'route',
] as const;

export const WELL_HISTORY_ALLOWLIST = [
  'wellName',
  'driverName',
  'dateTime',
  'dateTimeUTC',
  'bblsTaken',
  'tankLevelFeet',
  'tankTopInches',
  'tankAfterInches',
  'timeDif',
  'recoveryInches',
  'flowRate',
  'flowRateDays',
  'editedAt',
  'editedBy',
  'editCount',
  'originalSubmittedAt',
  'isEdit',
  'noLevel',
  'jobType',
  'wellDown',
  'packetId',
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
  canViewWellPool: boolean;
  approved: Record<string, Record<string, unknown>>;
  profiles: Record<string, Record<string, unknown>>;
  users: Record<string, Record<string, unknown>>;
  pending: Record<string, Record<string, unknown>>;
  wellConfig: Record<string, Record<string, unknown>>;
  wellStatus: Record<string, Record<string, unknown>>;
  counts: {
    approved: number;
    profiles: number;
    users: number;
    pending: number;
    wellConfig: number;
    wellStatus: number;
  };
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

export function callerCanViewGlobalWellPool(
  caller: Pick<DashboardCaller, 'companyId' | 'isPlatformAdmin'>,
): boolean {
  const cid = typeof caller.companyId === 'string' ? caller.companyId.trim() : '';
  if (caller.isPlatformAdmin) return true;
  return !cid || cid === LEGACY_WELL_POOL_COMPANY_ID;
}

export function pickAllowlisted(
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

function newerStatus(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const at = Date.parse(String(a.timestampUTC || a.timestamp || '')) || 0;
  const bt = Date.parse(String(b.timestampUTC || b.timestamp || '')) || 0;
  return at >= bt;
}

export function projectWellStatus(outgoing: unknown): Record<string, Record<string, unknown>> {
  const source = asRecord(outgoing);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, val] of Object.entries(source)) {
    if (!key.startsWith('response_') || key.includes('delete')) continue;
    const rec = asRecord(val);
    const wellName = typeof rec.wellName === 'string' ? rec.wellName.trim() : '';
    if (!wellName) continue;
    const picked = pickAllowlisted(rec, WELL_STATUS_ALLOWLIST);
    picked.responseId = key;
    const prev = out[wellName];
    if (!prev || newerStatus(picked, prev)) out[wellName] = picked;
  }
  return out;
}

export function projectDashboardCatalog(input: {
  approved: unknown;
  profiles?: unknown;
  users: unknown;
  wellConfig: unknown;
  pending?: unknown;
  outgoing?: unknown;
  caller: Pick<DashboardCaller, 'companyId' | 'isPlatformAdmin'>;
}): ProjectedDashboardCatalog {
  const scope: CatalogScope = input.caller.isPlatformAdmin ? 'platform' : 'company';
  const companyId = input.caller.isPlatformAdmin
    ? null
    : (typeof input.caller.companyId === 'string' ? input.caller.companyId.trim() : '');
  const filterCompany = scope === 'company' ? (companyId || '__none__') : null;
  const canViewWellPool = callerCanViewGlobalWellPool(input.caller);

  const approved = projectMap(input.approved, flattenApprovedEntry, filterCompany);
  const profiles = projectMap(
    input.profiles,
    (val) => pickAllowlisted(asRecord(val), CANONICAL_PROFILE_ALLOWLIST),
    filterCompany,
  );
  const users = projectMap(
    input.users,
    (val) => pickAllowlisted(asRecord(val), USER_ALLOWLIST),
    filterCompany,
  );
  const pending = projectMap(
    input.pending,
    (val) => pickAllowlisted(asRecord(val), PENDING_ALLOWLIST),
    filterCompany,
  );

  const wellConfig = canViewWellPool
    ? projectMap(
        input.wellConfig,
        (val) => pickAllowlisted(asRecord(val), WELL_CONFIG_ALLOWLIST),
        null,
      )
    : {};
  const wellStatus = canViewWellPool ? projectWellStatus(input.outgoing) : {};

  return {
    scope,
    companyId: scope === 'company' ? (companyId || null) : null,
    canViewWellPool,
    approved,
    profiles,
    users,
    pending,
    wellConfig,
    wellStatus,
    counts: {
      approved: Object.keys(approved).length,
      profiles: Object.keys(profiles).length,
      users: Object.keys(users).length,
      pending: Object.keys(pending).length,
      wellConfig: Object.keys(wellConfig).length,
      wellStatus: Object.keys(wellStatus).length,
    },
  };
}
