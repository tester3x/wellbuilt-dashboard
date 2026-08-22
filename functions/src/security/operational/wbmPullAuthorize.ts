/**
 * Canonical WB-M pull authorization and strict packet projection.
 * Catalog filtering is not authorization.
 */
import { createHash } from 'crypto';
import {
  evaluateWbmWellScope,
  wellBelongsToDriverCompany,
  wellMatchesWbmScope,
} from './wbmWellScope';

export const MAX_PACKET_BYTES = 200_000;
export const PULL_ALLOWLIST = [
  'requestType',
  'wellName',
  'dateTimeUTC',
  'dateTime',
  'timezone',
  'tankLevelFeet',
  'bblsTaken',
  'wellDown',
  'wellDownIsAuthoritative',
  'predictedLevelInches',
  'packetId',
  'idempotencyKey',
] as const;

const ALLOWED = new Set<string>(PULL_ALLOWLIST);

export type WbmPullOk = {
  ok: true;
  wellName: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
};

export type WbmPullDecision = WbmPullOk | { ok: false; reason: string };

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function boundedString(v: unknown, field: string, min: number, max: number):
  { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof v !== 'string') return { ok: false, reason: `missing_${field}` };
  const value = v.trim();
  if (value.length < min || value.length > max) return { ok: false, reason: `invalid_${field}` };
  return { ok: true, value };
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function canonicalPayloadDigest(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return sha256Hex(JSON.stringify(keys.map((k) => [k, payload[k]])));
}

const FIREBASE_UNSAFE_KEY = /[.#$\[\]/]/;
/** mintPacketId: YYYYMMDD_HHMMSS_{wellNameWithoutSpaces}_{rand6} */
const MINT_PACKET_ID = /^(\d{8})_(\d{6})_(.+)_([a-z0-9]{6})$/;

export function isFirebaseKeySafe(id: string): boolean {
  if (!id || id.length < 8 || id.length > 128) return false;
  if (FIREBASE_UNSAFE_KEY.test(id)) return false;
  if (id === '.' || id === '..') return false;
  return true;
}

export function matchesMintPacketId(id: string, wellName: string): boolean {
  const m = MINT_PACKET_ID.exec(id);
  if (!m) return false;
  return m[3] === wellName.replace(/\s+/g, '');
}

/**
 * The RTDB child key IS the minted WB-M packetId. Never hashed, prefixed,
 * or sanitized into a different identifier. processIncomingPull binds
 * context.params.packetId to this child key.
 */
export function wbmPullStorageKey(canonicalPacketId: string): string {
  return canonicalPacketId;
}

export function wbmIncomingPath(canonicalPacketId: string): string {
  return `packets/incoming/${wbmPullStorageKey(canonicalPacketId)}`;
}

export function evaluateWbmPull(input: {
  packet: unknown;
  companyId: string;
  assignedRoutes: unknown;
  assignedWells: unknown;
  wellConfig: Record<string, unknown>;
}): WbmPullDecision {
  if (!input.packet || typeof input.packet !== 'object' || Array.isArray(input.packet)) {
    return { ok: false, reason: 'packet_required' };
  }
  const packet = input.packet as Record<string, unknown>;
  if (utf8Bytes(JSON.stringify(packet)) > MAX_PACKET_BYTES) {
    return { ok: false, reason: 'packet_too_large' };
  }

  for (const key of Object.keys(packet)) {
    if (!ALLOWED.has(key)) return { ok: false, reason: 'unexpected_field' };
    const v = packet[key];
    if (v !== null && typeof v === 'object') return { ok: false, reason: 'unexpected_object' };
  }

  if (packet.requestType !== 'pull') return { ok: false, reason: 'unsupported_request_type' };

  const wellName = boundedString(packet.wellName, 'wellName', 1, 120);
  if (!wellName.ok) return wellName;
  const dateTimeUTC = boundedString(packet.dateTimeUTC, 'dateTimeUTC', 10, 40);
  if (!dateTimeUTC.ok) return dateTimeUTC;
  const parsed = Date.parse(dateTimeUTC.value);
  if (!Number.isFinite(parsed)) return { ok: false, reason: 'invalid_dateTimeUTC' };
  const year = new Date(parsed).getUTCFullYear();
  if (year < 2020 || year > 2036) return { ok: false, reason: 'invalid_dateTimeUTC' };

  if (packet.dateTime !== undefined) {
    const d = boundedString(packet.dateTime, 'dateTime', 1, 64);
    if (!d.ok) return d;
  }
  if (packet.timezone !== undefined) {
    const tz = boundedString(packet.timezone, 'timezone', 1, 64);
    if (!tz.ok) return tz;
  }

  if (typeof packet.tankLevelFeet !== 'number' || !Number.isFinite(packet.tankLevelFeet)
    || packet.tankLevelFeet < 0 || packet.tankLevelFeet > 40) {
    return { ok: false, reason: 'invalid_tankLevelFeet' };
  }
  if (typeof packet.bblsTaken !== 'number' || !Number.isFinite(packet.bblsTaken)
    || packet.bblsTaken < 0 || packet.bblsTaken > 20_000) {
    return { ok: false, reason: 'invalid_bblsTaken' };
  }
  if (packet.wellDown !== undefined && typeof packet.wellDown !== 'boolean') {
    return { ok: false, reason: 'invalid_wellDown' };
  }
  if (packet.wellDownIsAuthoritative !== undefined && typeof packet.wellDownIsAuthoritative !== 'boolean') {
    return { ok: false, reason: 'invalid_wellDownIsAuthoritative' };
  }
  if (packet.predictedLevelInches !== undefined) {
    if (typeof packet.predictedLevelInches !== 'number' || !Number.isFinite(packet.predictedLevelInches)
      || packet.predictedLevelInches < 0 || packet.predictedLevelInches > 480) {
      return { ok: false, reason: 'invalid_predictedLevelInches' };
    }
  }
  if (typeof packet.packetId !== 'string' || !packet.packetId) {
    return { ok: false, reason: 'missing_packetId' };
  }
  if (typeof packet.idempotencyKey !== 'string' || !packet.idempotencyKey) {
    return { ok: false, reason: 'missing_idempotency_key' };
  }
  if (packet.packetId !== packet.idempotencyKey) {
    return { ok: false, reason: 'packet_id_mismatch' };
  }
  const canonicalId = packet.packetId;
  if (!isFirebaseKeySafe(canonicalId) || !matchesMintPacketId(canonicalId, wellName.value)) {
    return { ok: false, reason: 'invalid_packetId' };
  }

  const scope = evaluateWbmWellScope(input.assignedRoutes, input.assignedWells);
  if (!scope.ok) return { ok: false, reason: scope.reason };

  const wellRaw = input.wellConfig[wellName.value];
  if (wellRaw === undefined) return { ok: false, reason: 'well_not_found' };
  const well = wellRaw && typeof wellRaw === 'object' && !Array.isArray(wellRaw)
    ? wellRaw as Record<string, unknown>
    : {};
  if (!wellBelongsToDriverCompany(well, input.companyId)) {
    return { ok: false, reason: 'cross_company_well' };
  }
  if (!wellMatchesWbmScope(wellName.value, well, scope)) {
    return { ok: false, reason: 'well_out_of_scope' };
  }

  const payload: Record<string, unknown> = {
    requestType: 'pull',
    wellName: wellName.value,
    dateTimeUTC: dateTimeUTC.value,
    tankLevelFeet: packet.tankLevelFeet,
    bblsTaken: packet.bblsTaken,
    packetId: canonicalId,
    idempotencyKey: canonicalId,
  };
  if (typeof packet.dateTime === 'string') payload.dateTime = packet.dateTime.trim();
  if (typeof packet.timezone === 'string') payload.timezone = packet.timezone.trim();
  if (typeof packet.wellDown === 'boolean') payload.wellDown = packet.wellDown;
  if (typeof packet.wellDownIsAuthoritative === 'boolean') {
    payload.wellDownIsAuthoritative = packet.wellDownIsAuthoritative;
  }
  if (typeof packet.predictedLevelInches === 'number') {
    payload.predictedLevelInches = packet.predictedLevelInches;
  }

  return {
    ok: true,
    wellName: wellName.value,
    idempotencyKey: canonicalId,
    payload,
    payloadDigest: canonicalPayloadDigest(payload),
  };
}

export type WbmPullTxDecision =
  | { action: 'write' }
  | { action: 'duplicate' }
  | { action: 'abort'; reason: 'idempotency_cross_driver' | 'idempotency_payload_conflict' };

export function decideWbmPullTransaction(input: {
  existing: Record<string, unknown> | null;
  driverId: string;
  payloadDigest: string;
}): WbmPullTxDecision {
  if (!input.existing) return { action: 'write' };
  if (input.existing.driverId !== input.driverId) {
    return { action: 'abort', reason: 'idempotency_cross_driver' };
  }
  if (input.existing.payloadDigest === input.payloadDigest) {
    return { action: 'duplicate' };
  }
  return { action: 'abort', reason: 'idempotency_payload_conflict' };
}
