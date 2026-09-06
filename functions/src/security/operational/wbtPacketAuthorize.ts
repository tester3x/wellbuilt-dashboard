/**
 * Canonical WB-T pull authorization. Does not use ingestWbmPull.
 * Incoming RTDB child key IS the client-minted packetId.
 */
import {
  canonicalPayloadDigest,
  isFirebaseKeySafe,
  matchesMintPacketId,
  MAX_PACKET_BYTES,
  sha256Hex,
} from './wbmPullAuthorize';
import { wellBelongsToDriverCompany } from './wbmWellScope';

export { canonicalPayloadDigest, isFirebaseKeySafe, matchesMintPacketId, sha256Hex };

export const WBT_PULL_FIELD_ALLOWLIST = [
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
  'driverName',
  'driverId',
  'jobType',
  'jobOrigin',
  'invoiceDocId',
  'dispatchId',
  'companyId',
  'invoicingMode',
  'originAppContext',
  'wellConfigKey',
  'wellId',
] as const;

const ALLOWED = new Set<string>(WBT_PULL_FIELD_ALLOWLIST);

export type WbtPullOk = {
  ok: true;
  wellName: string;
  packetId: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
};

export type WbtPullDecision = WbtPullOk | { ok: false; reason: string };

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

export function wbtPullStorageKey(canonicalPacketId: string): string {
  return canonicalPacketId;
}

export function wbtIncomingPath(canonicalPacketId: string): string {
  return `packets/incoming/${wbtPullStorageKey(canonicalPacketId)}`;
}

function optionalBoundedString(
  v: unknown,
  field: string,
  min: number,
  max: number,
): { ok: true; value?: string } | { ok: false; reason: string } {
  if (v === undefined || v === null || v === '') return { ok: true };
  return boundedString(v, field, min, max);
}

export function evaluateWbtDriverPacket(input: {
  packet: unknown;
  companyId: string;
  wellConfig: Record<string, unknown>;
}): WbtPullDecision {
  if (!input.packet || typeof input.packet !== 'object' || Array.isArray(input.packet)) {
    return { ok: false, reason: 'packet_required' };
  }
  const packet = input.packet as Record<string, unknown>;
  if (utf8Bytes(JSON.stringify(packet)) > MAX_PACKET_BYTES) {
    return { ok: false, reason: 'packet_too_large' };
  }
  if (!input.companyId) return { ok: false, reason: 'company_required' };

  for (const key of Object.keys(packet)) {
    if (!ALLOWED.has(key)) return { ok: false, reason: 'unexpected_field' };
    const v = packet[key];
    if (v !== null && typeof v === 'object') return { ok: false, reason: 'unexpected_object' };
  }

  if (packet.requestType !== undefined && packet.requestType !== 'pull') {
    return { ok: false, reason: 'unsupported_request_type' };
  }

  const wellName = boundedString(packet.wellName, 'wellName', 1, 120);
  if (!wellName.ok) return wellName;
  const dateTimeUTC = boundedString(packet.dateTimeUTC, 'dateTimeUTC', 10, 40);
  if (!dateTimeUTC.ok) return dateTimeUTC;
  const parsed = Date.parse(dateTimeUTC.value);
  if (!Number.isFinite(parsed)) return { ok: false, reason: 'invalid_dateTimeUTC' };
  const year = new Date(parsed).getUTCFullYear();
  if (year < 2020 || year > 2036) return { ok: false, reason: 'invalid_dateTimeUTC' };

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
  if (canonicalId.startsWith('idem_') || canonicalId.startsWith('wbm_')) {
    return { ok: false, reason: 'invalid_packetId' };
  }

  const clientCompany = optionalBoundedString(packet.companyId, 'companyId', 1, 80);
  if (!clientCompany.ok) return clientCompany;
  if (clientCompany.value && clientCompany.value !== input.companyId) {
    return { ok: false, reason: 'cross_company_packet' };
  }

  const wellKey = typeof packet.wellConfigKey === 'string' && packet.wellConfigKey.trim()
    ? packet.wellConfigKey.trim()
    : wellName.value;
  const wellRaw = input.wellConfig[wellKey] !== undefined
    ? input.wellConfig[wellKey]
    : input.wellConfig[wellName.value];
  if (wellRaw === undefined) return { ok: false, reason: 'well_not_found' };
  const well = wellRaw && typeof wellRaw === 'object' && !Array.isArray(wellRaw)
    ? wellRaw as Record<string, unknown>
    : {};
  if (!wellBelongsToDriverCompany(well, input.companyId)) {
    return { ok: false, reason: 'cross_company_well' };
  }

  const originApp = packet.originAppContext;
  if (originApp !== undefined && originApp !== 'wbt' && originApp !== 'wbm') {
    return { ok: false, reason: 'invalid_originAppContext' };
  }
  const invoicing = packet.invoicingMode;
  if (invoicing !== undefined
    && invoicing !== 'invoice_tickets'
    && invoicing !== 'ticket_only'
    && invoicing !== 'hybrid') {
    return { ok: false, reason: 'invalid_invoicingMode' };
  }

  const payload: Record<string, unknown> = {
    requestType: 'pull',
    wellName: wellName.value,
    dateTimeUTC: dateTimeUTC.value,
    tankLevelFeet: packet.tankLevelFeet,
    bblsTaken: packet.bblsTaken,
    packetId: canonicalId,
    idempotencyKey: canonicalId,
    originAppContext: originApp === 'wbm' ? 'wbm' : 'wbt',
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
  if (typeof packet.jobType === 'string' && packet.jobType.trim()) {
    payload.jobType = packet.jobType.trim();
  }
  if (typeof packet.jobOrigin === 'string' && packet.jobOrigin.trim()) {
    payload.jobOrigin = packet.jobOrigin.trim();
  }
  if (typeof packet.invoiceDocId === 'string' && packet.invoiceDocId.trim()) {
    payload.invoiceDocId = packet.invoiceDocId.trim();
  }
  if (typeof packet.dispatchId === 'string' && packet.dispatchId.trim()) {
    payload.dispatchId = packet.dispatchId.trim();
  }
  if (typeof packet.invoicingMode === 'string') payload.invoicingMode = packet.invoicingMode;
  if (typeof packet.wellConfigKey === 'string' && packet.wellConfigKey.trim()) {
    payload.wellConfigKey = packet.wellConfigKey.trim();
  } else {
    payload.wellConfigKey = wellKey;
  }
  if (typeof packet.wellId === 'string' && packet.wellId.trim()) {
    payload.wellId = packet.wellId.trim();
  }

  return {
    ok: true,
    wellName: wellName.value,
    packetId: canonicalId,
    payload,
    payloadDigest: canonicalPayloadDigest(payload),
  };
}

export type WbtPullTxDecision =
  | { action: 'write' }
  | { action: 'duplicate' }
  | { action: 'abort'; reason: 'idempotency_cross_driver' | 'idempotency_payload_conflict' };

export function decideWbtPullTransaction(input: {
  existing: Record<string, unknown> | null;
  driverId: string;
  payloadDigest: string;
}): WbtPullTxDecision {
  if (!input.existing) return { action: 'write' };
  if (input.existing.driverId !== input.driverId) {
    return { action: 'abort', reason: 'idempotency_cross_driver' };
  }
  if (input.existing.payloadDigest === input.payloadDigest) return { action: 'duplicate' };
  return { action: 'abort', reason: 'idempotency_payload_conflict' };
}
