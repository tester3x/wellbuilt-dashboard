/**
 * Endpoint-scoped HMAC authentication and validation for WhatsApp Watchdog bridge.
 * Strictly implements the contract defined in docs/WATCHDOG-HMAC-REVIEW-20260912.md:
 * - Accepts only dedicated Watchdog principal (wb-rnd-watchdog -> liquid-gold).
 * - Verifies HMAC-SHA256 headers with versioned string bound to endpoint, method, timestamp, nonce, and body SHA.
 * - Enforces replay rejection via durable nonce ledger.
 * - Strictly rejects client companyId, driver credentials, wellDown flags, and commercial fields.
 * - Stores submissions in integration ledger; never touches commercial or JSA collections.
 */

import * as crypto from 'crypto';
import * as admin from 'firebase-admin';

export const WATCHDOG_PRINCIPAL_ID = 'wb-rnd-watchdog';
export const WATCHDOG_PRINCIPAL_OWNER = 'wellbuilt';
export const WATCHDOG_COMPANY_ID = 'liquid-gold';
export const WATCHDOG_SOURCE = 'whatsapp_watchdog';
export const WATCHDOG_ENVIRONMENT = 'rnd';

export const MAX_SKEW_MS = 300_000; // 5 minutes
export const MAX_BODY_BYTES = 65_536; // 64 KB

export const FORBIDDEN_WATCHDOG_FIELDS = [
  'companyId',
  'driverId',
  'driverName',
  'driverHash',
  'driverUid',
  'wellDown',
  'wellDownIsAuthoritative',
  'ticketNumber',
  'invoiceDocId',
  'invoiceNumber',
  'dispatchId',
  'jid',
  'invoicingMode',
  'payroll',
  'billing',
  'billing_invoices',
  'afr',
  'flowRate',
  'flowRateDays',
  'tanks',
  'bblPerFoot',
] as const;

export const MINT_PACKET_ID_REGEX = /^(\d{8}_\d{6})_([A-Za-z0-9]+)_([a-f0-9]{6})$/;

export interface HmacVerificationResult {
  ok: boolean;
  code: number;
  error?: string;
  keyId?: string;
  principalId?: string;
}

export interface WatchdogObservationPayload {
  packetId: string;
  wellName: string;
  top: number;
  bottom: number;
  explicitBbl: number;
  dateTimeUTC: string;
  timezone?: string;
  chat?: string;
  sender?: string;
  eventTimeLocal?: string;
  parserVersion?: string;
  digest?: string;
  evidenceRef?: string;
  [key: string]: unknown;
}

export interface ValidatedObservation {
  packetId: string;
  wellName: string;
  top: number;
  bottom: number;
  bbl: number;
  dateTimeUTC: string;
  dateTime: string;
  timezone: string;
  observationDigest: string;
  rawPayload: Record<string, unknown>;
}

export function getWatchdogHmacSecret(keyId: string): string | null {
  const envKey = process.env[`WATCHDOG_HMAC_KEY_${keyId.toUpperCase()}`] || process.env.WATCHDOG_HMAC_KEY || process.env.WATCHDOG_HMAC_SECRET;
  if (envKey) return envKey;

  // Fallback for emulator / demo tests
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.FUNCTIONS_EMULATOR === 'true' ||
    Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST) ||
    (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT.startsWith('demo-'))
  ) {
    return 'demo-watchdog-hmac-secret-key-32chars!';
  }

  return null;
}

export function computeBodySha256(rawBody: string | Buffer): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

export function buildStringToSign(params: {
  endpointName: string;
  method: string;
  timestamp: string | number;
  nonce: string;
  bodySha256: string;
}): string {
  return `v1:${params.endpointName}:${params.method.toUpperCase()}:${params.timestamp}:${params.nonce}:${params.bodySha256}`;
}

export function verifyHmacHeaders(params: {
  endpointName: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Buffer;
  nowMs?: number;
}): HmacVerificationResult {
  const getHeader = (name: string): string => {
    const val = params.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0] || '';
    return typeof val === 'string' ? val.trim() : '';
  };

  const keyId = getHeader('x-watchdog-key-id') || getHeader('x-hmac-key-id');
  const timestampStr = getHeader('x-watchdog-timestamp') || getHeader('x-hmac-timestamp');
  const nonce = getHeader('x-watchdog-nonce') || getHeader('x-hmac-nonce');
  const signature = getHeader('x-watchdog-signature') || getHeader('x-hmac-signature');

  if (!keyId || !timestampStr || !nonce || !signature) {
    return { ok: false, code: 401, error: 'missing_hmac_headers' };
  }

  const secret = getWatchdogHmacSecret(keyId);
  if (!secret) {
    return { ok: false, code: 401, error: 'unknown_key_id' };
  }

  const now = params.nowMs ?? Date.now();
  let timestampMs = Number(timestampStr);
  if (!Number.isFinite(timestampMs)) {
    timestampMs = Date.parse(timestampStr);
  }
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_SKEW_MS) {
    return { ok: false, code: 401, error: 'timestamp_skew_exceeded' };
  }

  if (nonce.length < 8) {
    return { ok: false, code: 401, error: 'invalid_nonce' };
  }

  const bodySha = computeBodySha256(params.rawBody);
  const stringToSign = buildStringToSign({
    endpointName: params.endpointName,
    method: params.method,
    timestamp: timestampStr,
    nonce,
    bodySha256: bodySha,
  });

  const expectedSignature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');

  const sigBuf = Buffer.from(signature.toLowerCase(), 'hex');
  const expBuf = Buffer.from(expectedSignature.toLowerCase(), 'hex');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, code: 401, error: 'signature_mismatch' };
  }

  return {
    ok: true,
    code: 200,
    keyId,
    principalId: WATCHDOG_PRINCIPAL_ID,
  };
}

export async function checkAndRecordNonce(db: admin.database.Database, nonce: string, nowMs: number): Promise<boolean> {
  const nonceRef = db.ref(`integration_ledgers/watchdog/nonces/${nonce}`);
  const txn = await nonceRef.transaction((curr) => {
    if (curr !== null) return undefined; // abort if already used
    return {
      usedAtMs: nowMs,
      usedAtUtc: new Date(nowMs).toISOString(),
    };
  });
  return txn.committed;
}

export function validateObservationPayload(raw: unknown, nowMs: number): { ok: true; value: ValidatedObservation } | { ok: false; code: number; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 400, error: 'invalid_json_payload' };
  }
  const body = raw as Record<string, unknown>;

  // Check for forbidden fields
  for (const forbidden of FORBIDDEN_WATCHDOG_FIELDS) {
    if (forbidden in body) {
      return { ok: false, code: 400, error: `forbidden_field:${forbidden}` };
    }
  }

  // Well Name
  const wellName = typeof body.wellName === 'string' ? body.wellName.trim() : '';
  if (!wellName) {
    return { ok: false, code: 400, error: 'missing_well_name' };
  }

  // Packet ID
  const packetId = typeof body.packetId === 'string' ? body.packetId.trim() : '';
  if (!packetId) {
    return { ok: false, code: 400, error: 'missing_packet_id' };
  }
  const match = MINT_PACKET_ID_REGEX.exec(packetId);
  if (!match) {
    return { ok: false, code: 400, error: 'invalid_packet_id_shape' };
  }
  const cleanWell = wellName.replace(/\s+/g, '');
  if (match[2] !== cleanWell) {
    return { ok: false, code: 400, error: 'packet_id_well_mismatch' };
  }

  // Levels: top and bottom
  const top = typeof body.top === 'number' && Number.isFinite(body.top)
    ? body.top
    : typeof body.tankLevelFeet === 'number' && Number.isFinite(body.tankLevelFeet)
    ? body.tankLevelFeet
    : null;
  if (top === null || top < 0 || top > 60) {
    return { ok: false, code: 400, error: 'invalid_top_level' };
  }

  const bottom = typeof body.bottom === 'number' && Number.isFinite(body.bottom)
    ? body.bottom
    : typeof body.bottomLevelFeet === 'number' && Number.isFinite(body.bottomLevelFeet)
    ? body.bottomLevelFeet
    : null;
  if (bottom === null || bottom < 0 || bottom > 60) {
    return { ok: false, code: 400, error: 'missing_or_invalid_bottom_level' };
  }
  if (bottom > top) {
    return { ok: false, code: 400, error: 'bottom_level_exceeds_top_level' };
  }

  // Barrels
  const bbl = typeof body.explicitBbl === 'number' && Number.isFinite(body.explicitBbl)
    ? body.explicitBbl
    : typeof body.bblsTaken === 'number' && Number.isFinite(body.bblsTaken)
    ? body.bblsTaken
    : null;
  if (bbl === null || bbl <= 0 || bbl > 100000) {
    return { ok: false, code: 400, error: 'invalid_bbl_taken' };
  }

  // DateTimeUTC
  const dateTimeUTC = typeof body.dateTimeUTC === 'string' ? body.dateTimeUTC.trim() : '';
  const dtMs = Date.parse(dateTimeUTC);
  if (!dateTimeUTC || !Number.isFinite(dtMs)) {
    return { ok: false, code: 400, error: 'invalid_dateTimeUTC' };
  }
  if (dtMs > nowMs + MAX_SKEW_MS) {
    return { ok: false, code: 400, error: 'dateTimeUTC_future' };
  }
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (dtMs < nowMs - THIRTY_DAYS_MS) {
    return { ok: false, code: 400, error: 'dateTimeUTC_too_old' };
  }

  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'America/Chicago';
  const dateTime = typeof body.dateTime === 'string' && body.dateTime.trim()
    ? body.dateTime.trim()
    : new Date(dtMs).toLocaleString('en-US', { timeZone: timezone });

  // Semantic observation digest
  const digestString = `${wellName}:${dateTimeUTC}:${top.toFixed(4)}:${bottom.toFixed(4)}:${bbl.toFixed(2)}`;
  const observationDigest = crypto.createHash('sha256').update(digestString).digest('hex');

  return {
    ok: true,
    value: {
      packetId,
      wellName,
      top,
      bottom,
      bbl,
      dateTimeUTC,
      dateTime,
      timezone,
      observationDigest,
      rawPayload: body,
    },
  };
}
