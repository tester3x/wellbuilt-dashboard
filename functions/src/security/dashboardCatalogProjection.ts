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
  'wellId',
  'companyId',
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

    // Retain distinct same-named wells across companies under canonical composite identity
    const companyId = typeof rec.companyId === 'string' ? rec.companyId.trim() : '';
    const wellId = canonicalWellId(rec);
    if (companyId && wellId) {
      const canonicalKey = `${companyId}__${wellId}`;
      const prevCanonical = out[canonicalKey];
      if (!prevCanonical || newerStatus(picked, prevCanonical)) {
        out[canonicalKey] = picked;
      }
    }

    // Display-name lookup (backward-compatible)
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

/** Canonical well identity (config.wellId, else config.id). '' when absent. */
export function canonicalWellId(rec: Record<string, unknown>): string {
  const raw = rec.wellId ?? rec.id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

export type CompanyWellPool = {
  wellConfig: Record<string, Record<string, unknown>>;
  wellStatus: Record<string, Record<string, unknown>>;
  counts: { wellConfig: number; wellStatus: number };
};

/**
 * COMPANY-SCOPED governed well pool. Returns ONLY wells positively proven to belong
 * to `companyId`. Filtering happens BEFORE projection; there is NO global wellName
 * join and NO `companyId || 'liquid-gold'` default — every tenant identity must be
 * explicit and exact, and anything missing fails CLOSED.
 *
 * A configured well is included only when config.companyId === companyId (exact).
 * A status row is attached to that well ONLY when ALL of the following are proven on
 * the RAW outgoing row (not the wellName-deduped global projection):
 *   1. status.companyId === companyId (exact; missing → rejected),
 *   2. status carries a canonical wellId, and
 *   3. that wellId === the configuration's canonical wellId for the same well.
 * A configured well with no provably-owned status is returned with NO status row —
 * the client renders it unavailable. If the global writer's wellName dedupe left only
 * another company's row for a well name this company owns, that foreign row fails the
 * companyId/wellId proofs and is rejected: the owner gets its configuration with
 * status unavailable, NEVER the surviving foreign row, NEVER a zero.
 */
export function projectCompanyWellPool(
  companyId: string,
  wellConfig: unknown,
  outgoing: unknown,
): CompanyWellPool {
  const cid = typeof companyId === 'string' ? companyId.trim() : '';
  const outConfig: Record<string, Record<string, unknown>> = {};
  const outStatus: Record<string, Record<string, unknown>> = {};
  if (!cid) return { wellConfig: outConfig, wellStatus: outStatus, counts: { wellConfig: 0, wellStatus: 0 } };

  // 1. Configuration: exact, explicit company only (fail closed on missing companyId).
  const rawConfig = asRecord(wellConfig);
  const wellIdToConfigKeys = new Map<string, string[]>();
  for (const [cfgKey, val] of Object.entries(rawConfig)) {
    const cfg = asRecord(val);
    const cfgCompany = typeof cfg.companyId === 'string' ? cfg.companyId.trim() : '';
    if (!cfgCompany || cfgCompany !== cid) continue;
    outConfig[cfgKey] = pickAllowlisted(cfg, WELL_CONFIG_ALLOWLIST);
    const wid = canonicalWellId(cfg) || cfgKey;
    if (wid) {
      const list = wellIdToConfigKeys.get(wid) || [];
      list.push(cfgKey);
      wellIdToConfigKeys.set(wid, list);
    }
  }

  // 2. Status: attach ONLY when company AND canonical wellId both prove out, read from
  //    the RAW outgoing rows so a same-name row from another company cannot be joined.
  const rawOut = asRecord(outgoing);
  for (const [key, val] of Object.entries(rawOut)) {
    if (!key.startsWith('response_') || key.includes('delete')) continue;
    const row = asRecord(val);
    const rowCompany = typeof row.companyId === 'string' ? row.companyId.trim() : '';
    if (!rowCompany || rowCompany !== cid) continue;                 // status company must be explicit + exact
    const rowWellId = canonicalWellId(row);
    if (!rowWellId) continue;
    const matchingConfigKeys = wellIdToConfigKeys.get(rowWellId);
    if (!matchingConfigKeys || matchingConfigKeys.length === 0) continue;
    const picked = pickAllowlisted(row, WELL_STATUS_ALLOWLIST);
    picked.responseId = key;
    for (const targetKey of matchingConfigKeys) {
      const prev = outStatus[targetKey];
      if (!prev || newerStatus(picked, prev)) outStatus[targetKey] = picked;
    }
    const wellName = typeof row.wellName === 'string' ? row.wellName.trim() : '';
    if (wellName && (wellName in outConfig)) {
      const prev = outStatus[wellName];
      if (!prev || newerStatus(picked, prev)) outStatus[wellName] = picked;
    }
  }

  return {
    wellConfig: outConfig,
    wellStatus: outStatus,
    counts: { wellConfig: Object.keys(outConfig).length, wellStatus: Object.keys(outStatus).length },
  };
}
