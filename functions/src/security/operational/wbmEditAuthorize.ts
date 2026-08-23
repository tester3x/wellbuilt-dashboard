/**
 * Canonical WB-M edit authorization. Writes nothing. Catalog filtering
 * is not authorization. Empty dateTime/dateTimeUTC means preserve the
 * original pull's operational time — never substitute "now".
 */
import {
  canonicalPayloadDigest,
  isFirebaseKeySafe,
  MAX_PACKET_BYTES,
} from './wbmPullAuthorize';
import {
  evaluateWbmWellScope,
  wellBelongsToDriverCompany,
  wellMatchesWbmScope,
} from './wbmWellScope';

export const EDIT_ALLOWLIST = [
  'requestType',
  'wellName',
  'originalPacketId',
  'packetId',
  'dateTimeUTC',
  'dateTime',
  'timezone',
  'tankLevelFeet',
  'bblsTaken',
  'wellDown',
  'wellDownIsAuthoritative',
  'idempotencyKey',
] as const;

const ALLOWED = new Set<string>(EDIT_ALLOWLIST);

export type WbmEditOk = {
  ok: true;
  wellName: string;
  originalPacketId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
};

export type WbmEditDecision = WbmEditOk | { ok: false; reason: string };

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

export function wbmEditIncomingPath(idempotencyKey: string): string {
  return `packets/incoming/${idempotencyKey}`;
}

export function expectedEditIdempotencyKey(originalPacketId: string, wellName: string): string | null {
  const m = /^(\d{8}_\d{6})_/.exec(originalPacketId);
  if (!m) return null;
  return `edit_${m[1]}_${wellName.replace(/\s+/g, '')}`;
}

export function evaluateWbmEdit(input: {
  packet: unknown;
  companyId: string;
  driverId: string;
  assignedRoutes: unknown;
  assignedWells: unknown;
  wellConfig: Record<string, unknown>;
  original: Record<string, unknown> | null;
}): WbmEditDecision {
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
  if (packet.requestType !== 'edit') return { ok: false, reason: 'unsupported_request_type' };

  const wellName = boundedString(packet.wellName, 'wellName', 1, 120);
  if (!wellName.ok) return wellName;

  const originalPacketId = boundedString(
    packet.originalPacketId || packet.packetId,
    'originalPacketId',
    8,
    128,
  );
  if (!originalPacketId.ok) return originalPacketId;
  if (!isFirebaseKeySafe(originalPacketId.value)) {
    return { ok: false, reason: 'invalid_originalPacketId' };
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

  let dateTimeUTC: string | undefined;
  if (packet.dateTimeUTC !== undefined && packet.dateTimeUTC !== '') {
    const d = boundedString(packet.dateTimeUTC, 'dateTimeUTC', 10, 40);
    if (!d.ok) return d;
    const parsed = Date.parse(d.value);
    if (!Number.isFinite(parsed)) return { ok: false, reason: 'invalid_dateTimeUTC' };
    const year = new Date(parsed).getUTCFullYear();
    if (year < 2020 || year > 2036) return { ok: false, reason: 'invalid_dateTimeUTC' };
    dateTimeUTC = d.value;
  }
  let dateTime: string | undefined;
  if (packet.dateTime !== undefined && packet.dateTime !== '') {
    const d = boundedString(packet.dateTime, 'dateTime', 1, 64);
    if (!d.ok) return d;
    dateTime = d.value;
  }
  let timezone: string | undefined;
  if (packet.timezone !== undefined && packet.timezone !== '') {
    const tz = boundedString(packet.timezone, 'timezone', 1, 64);
    if (!tz.ok) return tz;
    timezone = tz.value;
  }

  const expectedKey = expectedEditIdempotencyKey(originalPacketId.value, wellName.value);
  if (!expectedKey) return { ok: false, reason: 'invalid_originalPacketId' };
  const idempotencyKey = boundedString(packet.idempotencyKey, 'idempotency_key', 8, 128);
  if (!idempotencyKey.ok) return idempotencyKey;
  if (idempotencyKey.value !== expectedKey || !isFirebaseKeySafe(idempotencyKey.value)) {
    return { ok: false, reason: 'idempotency_key_mismatch' };
  }

  if (!input.original) return { ok: false, reason: 'missing_original' };
  const origWell = typeof input.original.wellName === 'string' ? input.original.wellName : '';
  if (origWell !== wellName.value) return { ok: false, reason: 'forged_well' };
  const origDriver = typeof input.original.driverId === 'string' ? input.original.driverId : '';
  if (origDriver && origDriver !== input.driverId) return { ok: false, reason: 'cross_driver' };

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
    requestType: 'edit',
    wellName: wellName.value,
    originalPacketId: originalPacketId.value,
    packetId: originalPacketId.value,
    tankLevelFeet: packet.tankLevelFeet,
    bblsTaken: packet.bblsTaken,
    wellDown: packet.wellDown === true,
    idempotencyKey: idempotencyKey.value,
  };
  if (dateTimeUTC) payload.dateTimeUTC = dateTimeUTC;
  if (dateTime) payload.dateTime = dateTime;
  if (timezone) payload.timezone = timezone;
  if (typeof packet.wellDownIsAuthoritative === 'boolean') {
    payload.wellDownIsAuthoritative = packet.wellDownIsAuthoritative;
  }

  return {
    ok: true,
    wellName: wellName.value,
    originalPacketId: originalPacketId.value,
    idempotencyKey: idempotencyKey.value,
    payload,
    payloadDigest: canonicalPayloadDigest(payload),
  };
}

export type WbmEditTxDecision =
  | { action: 'write' }
  | { action: 'duplicate' }
  | { action: 'abort'; reason: 'idempotency_cross_driver' | 'idempotency_payload_conflict' };

export function decideWbmEditTransaction(input: {
  existing: Record<string, unknown> | null;
  driverId: string;
  payloadDigest: string;
}): WbmEditTxDecision {
  if (!input.existing) return { action: 'write' };
  if (input.existing.driverId !== input.driverId) {
    return { action: 'abort', reason: 'idempotency_cross_driver' };
  }
  if (input.existing.payloadDigest === input.payloadDigest) {
    return { action: 'duplicate' };
  }
  return { action: 'abort', reason: 'idempotency_payload_conflict' };
}
