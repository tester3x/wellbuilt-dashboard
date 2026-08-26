/**
 * Canonical WB-M / WB-T edit authorization. Writes nothing. Catalog filtering
 * is not authorization. Empty dateTime/dateTimeUTC means preserve the
 * original pull's operational time — never substitute "now". Explicit times
 * must be offset-aware (Z or numeric offset).
 *
 * Identity: client-minted editEventId is the incoming child and history key.
 * originalPacketId is never reminted. Missing original driverId/companyId
 * fails closed — present-day well assignment is not ownership.
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
  'schemaVersion',
  'editedFields',
  'wellName',
  'originalPacketId',
  'packetId',
  'editEventId',
  'correctionCreatedAtUTC',
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

/** The governed v2 contract version. Selected explicitly; never inferred. */
export const GOVERNED_EDIT_SCHEMA_VERSION = 2 as const;

/** Field names a v2 correction may declare in editedFields. */
export const EDITED_FIELD_MASK_ALLOWLIST = [
  'tankLevelFeet',
  'tankTopInches',
  'bblsTaken',
  'dateTimeUTC',
  'dateTime',
  'wellDown',
] as const;
const EDITED_FIELD_MASK = new Set<string>(EDITED_FIELD_MASK_ALLOWLIST);

/** Absolute instants must carry Z or a numeric offset. Offsetless is rejected. */
const OFFSET_AWARE = /(Z|[+-]\d{2}:?\d{2})$/;

export function isAbsoluteInstant(iso: unknown): iso is string {
  if (typeof iso !== 'string') return false;
  const s = iso.trim();
  if (!s || !OFFSET_AWARE.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

export type WbmEditOk = {
  ok: true;
  wellName: string;
  originalPacketId: string;
  editEventId: string;
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

export function wbmEditIncomingPath(editEventId: string): string {
  return `packets/incoming/${editEventId}`;
}

export function wbmEditReceiptPath(editEventId: string): string {
  return `packets/editReceipts/${editEventId}`;
}

/**
 * Original pull owner/company. Missing identity is unavailable, not a grant
 * via present-day well assignment.
 */
export function resolveOriginalEditAuthority(input: {
  original: Record<string, unknown>;
  driverId: string;
  companyId: string;
}): { ok: true } | { ok: false; reason: string } {
  const origDriver = typeof input.original.driverId === 'string' ? input.original.driverId.trim() : '';
  if (!origDriver) return { ok: false, reason: 'original_owner_unavailable' };
  if (origDriver !== input.driverId) return { ok: false, reason: 'cross_driver' };

  const origCompany = typeof input.original.companyId === 'string' ? input.original.companyId.trim() : '';
  if (!origCompany) return { ok: false, reason: 'original_company_unavailable' };
  if (origCompany !== input.companyId) return { ok: false, reason: 'cross_company' };

  return { ok: true };
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
    // editedFields is the one allowed array; everything else must be scalar.
    if (key === 'editedFields') {
      if (!Array.isArray(v)) return { ok: false, reason: 'invalid_editedFields' };
      continue;
    }
    if (v !== null && typeof v === 'object') return { ok: false, reason: 'unexpected_object' };
  }
  if (packet.requestType !== 'edit') return { ok: false, reason: 'unsupported_request_type' };

  // Governed v2 contract must be selected EXPLICITLY — never inferred from the
  // presence of a timestamp or any other field. Fail closed otherwise.
  if (packet.schemaVersion === undefined) return { ok: false, reason: 'missing_schemaVersion' };
  if (packet.schemaVersion !== GOVERNED_EDIT_SCHEMA_VERSION) {
    return { ok: false, reason: 'invalid_schemaVersion' };
  }

  // Explicit, immutable per-field mutation mask. Required, non-empty, unique,
  // restricted to the editable-field allowlist. This — not any baseline diff —
  // is the authority for which fields the correction touched.
  const rawMask = packet.editedFields;
  if (!Array.isArray(rawMask)) return { ok: false, reason: 'missing_editedFields' };
  if (rawMask.length === 0) return { ok: false, reason: 'empty_editedFields' };
  const maskSeen = new Set<string>();
  for (const m of rawMask) {
    if (typeof m !== 'string' || !EDITED_FIELD_MASK.has(m)) {
      return { ok: false, reason: 'unknown_editedField' };
    }
    if (maskSeen.has(m)) return { ok: false, reason: 'duplicate_editedField' };
    maskSeen.add(m);
  }
  // Canonicalized, sorted mask for a stable digest (order-independent, so a
  // different SET of fields — not merely a reordering — changes the digest).
  const editedFields = Array.from(maskSeen).sort();

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

  const editEventId = boundedString(packet.editEventId, 'editEventId', 8, 128);
  if (!editEventId.ok) return editEventId;
  if (!isFirebaseKeySafe(editEventId.value)) {
    return { ok: false, reason: 'invalid_editEventId' };
  }
  if (editEventId.value === originalPacketId.value) {
    return { ok: false, reason: 'editEventId_collides_with_original' };
  }

  let idempotencyKey = editEventId.value;
  if (packet.idempotencyKey !== undefined && packet.idempotencyKey !== '') {
    const key = boundedString(packet.idempotencyKey, 'idempotency_key', 8, 128);
    if (!key.ok) return key;
    if (key.value !== editEventId.value) {
      return { ok: false, reason: 'idempotency_key_mismatch' };
    }
    idempotencyKey = key.value;
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

  // Immutable event-time. v2 governed corrections MUST carry it; it is the
  // ordering key for chronological materialization. Offset-aware, plausible
  // year, and DISTINCT from the editable business time (dateTimeUTC). Never
  // defaulted to "now" and never inferred from the pull's date/time.
  const cca = boundedString(packet.correctionCreatedAtUTC, 'correctionCreatedAtUTC', 10, 40);
  if (!cca.ok) return cca;
  if (!isAbsoluteInstant(cca.value)) return { ok: false, reason: 'invalid_correctionCreatedAtUTC' };
  const ccaYear = new Date(cca.value).getUTCFullYear();
  if (ccaYear < 2020 || ccaYear > 2036) return { ok: false, reason: 'invalid_correctionCreatedAtUTC' };
  const correctionCreatedAtUTC = cca.value;

  let dateTimeUTC: string | undefined;
  if (packet.dateTimeUTC !== undefined && packet.dateTimeUTC !== '') {
    const d = boundedString(packet.dateTimeUTC, 'dateTimeUTC', 10, 40);
    if (!d.ok) return d;
    if (!isAbsoluteInstant(d.value)) return { ok: false, reason: 'invalid_dateTimeUTC' };
    const year = new Date(d.value).getUTCFullYear();
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

  // Mask/payload consistency: an optional field declared in editedFields must
  // actually carry a value. (Level and BBLs are always present and validated.)
  if (maskSeen.has('dateTimeUTC') && dateTimeUTC === undefined) {
    return { ok: false, reason: 'editedField_value_missing' };
  }
  if (maskSeen.has('dateTime') && dateTime === undefined) {
    return { ok: false, reason: 'editedField_value_missing' };
  }
  if (maskSeen.has('wellDown') && packet.wellDown === undefined) {
    return { ok: false, reason: 'editedField_value_missing' };
  }

  if (!input.original) return { ok: false, reason: 'missing_original' };
  const origWell = typeof input.original.wellName === 'string' ? input.original.wellName : '';
  if (origWell !== wellName.value) return { ok: false, reason: 'forged_well' };

  const owner = resolveOriginalEditAuthority({
    original: input.original,
    driverId: input.driverId,
    companyId: input.companyId,
  });
  if (!owner.ok) return owner;

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
    schemaVersion: GOVERNED_EDIT_SCHEMA_VERSION,
    editedFields,
    wellName: wellName.value,
    originalPacketId: originalPacketId.value,
    packetId: originalPacketId.value,
    editEventId: editEventId.value,
    correctionCreatedAtUTC,
    tankLevelFeet: packet.tankLevelFeet,
    bblsTaken: packet.bblsTaken,
    wellDown: packet.wellDown === true,
    idempotencyKey,
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
    editEventId: editEventId.value,
    idempotencyKey,
    payload,
    payloadDigest: canonicalPayloadDigest(payload),
  };
}

export type WbmEditTxDecision =
  | { action: 'write' }
  | { action: 'queued' }
  | { action: 'abort'; reason: 'idempotency_cross_driver' | 'idempotency_payload_conflict' | 'edit_event_payload_conflict' };

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
    return { action: 'queued' };
  }
  return { action: 'abort', reason: 'idempotency_payload_conflict' };
}

export function decideWbmEditReceipt(input: {
  receipt: Record<string, unknown> | null;
  payloadDigest: string;
}):
  | { action: 'absent' }
  | { action: 'accepted' }
  | { action: 'abort'; reason: 'edit_event_payload_conflict' } {
  if (!input.receipt) return { action: 'absent' };
  const digest = typeof input.receipt.payloadDigest === 'string' ? input.receipt.payloadDigest : '';
  if (digest && digest === input.payloadDigest) return { action: 'accepted' };
  return { action: 'abort', reason: 'edit_event_payload_conflict' };
}
