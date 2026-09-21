/**
 * Dashboard Add Pull ingest. Company and actor from trusted authority.
 */
import { fail, type StoreResult } from './jobPacketRevisionStore';
import { collectAuthorizedWellNames, evaluateWellAuthorized } from './dispatchPacketPin';

export const STAFF_INGEST_PULL_KEYS = Object.freeze([
  'wellName',
  'tankLevelFeet',
  'bblsTaken',
  'dateTimeUTC',
  'timezone',
  'wellDown',
] as const);

export const STAFF_INGEST_PULL_FORBIDDEN = Object.freeze([
  'companyId',
  'role',
  'roles',
  'capabilities',
  'driverId',
  'driverName',
  'uid',
  'isPlatformAdmin',
  'wellbuiltAdmin',
] as const);

export type StaffPullRequest = {
  wellName: string;
  tankLevelFeet: number;
  bblsTaken: number;
  dateTimeUTC: string;
  timezone: string;
  wellDown: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function parseStaffIngestPull(raw: unknown): StoreResult<StaffPullRequest> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'request');
  for (const key of Object.getOwnPropertyNames(raw)) {
    if ((STAFF_INGEST_PULL_FORBIDDEN as readonly string[]).includes(key)) {
      return fail('caller_authority_field', key);
    }
    if (!(STAFF_INGEST_PULL_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }
  const wellName = typeof raw.wellName === 'string' ? raw.wellName.trim() : '';
  if (!wellName || wellName.length > 80) return fail('malformed_well', 'wellName');
  if (typeof raw.tankLevelFeet !== 'number' || !Number.isFinite(raw.tankLevelFeet) || raw.tankLevelFeet < 0) {
    return fail('malformed_level', 'tankLevelFeet');
  }
  if (typeof raw.bblsTaken !== 'number' || !Number.isFinite(raw.bblsTaken) || raw.bblsTaken < 0) {
    return fail('malformed_bbls', 'bblsTaken');
  }
  const dateTimeUTC = typeof raw.dateTimeUTC === 'string' ? raw.dateTimeUTC.trim() : '';
  if (!dateTimeUTC || Number.isNaN(Date.parse(dateTimeUTC))) return fail('malformed_datetime', 'dateTimeUTC');
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim()
    ? raw.timezone.trim().slice(0, 64)
    : 'UTC';
  const wellDown = raw.wellDown === undefined ? false : raw.wellDown === true;
  return { ok: true, wellName, tankLevelFeet: raw.tankLevelFeet, bblsTaken: raw.bblsTaken, dateTimeUTC, timezone, wellDown };
}

export function evaluateStaffIngestPull(input: {
  request: StaffPullRequest;
  catalog: unknown;
  actingCompanyId: string;
}): StoreResult<{ packetId: string; wellName: string }> {
  const catalog = collectAuthorizedWellNames(input.catalog, input.actingCompanyId);
  if (!catalog.ok) return catalog;
  const well = evaluateWellAuthorized(input.request.wellName, '', catalog.names, catalog.ambiguous);
  if (!well.ok) return well;
  const dt = new Date(input.request.dateTimeUTC);
  const stamp = dt.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const wellKey = input.request.wellName.replace(/\s/g, '').slice(0, 40);
  const packetId = `${stamp}_${wellKey}_dashboard`;
  if (packetId.includes('/') || packetId.includes('.')) return fail('malformed_id', 'packetId');
  return { ok: true, packetId, wellName: well.wellName };
}
