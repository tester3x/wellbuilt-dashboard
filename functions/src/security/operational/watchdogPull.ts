/**
 * Pure validation and packet construction for verified WhatsApp Watchdog pulls.
 *
 * Invariants:
 *  - Dedicated Watchdog principal with custom claim kind=watchdog.
 *  - Server-authoritative companyId from caller token; client override is strictly forbidden.
 *  - Zero commercial fields: no tickets, invoices, dispatches, payroll, billing, or driver identity.
 *  - Zero AFR distortion: transports observations only.
 *  - Strict packet ID matching the canonical mint pattern (YYYYMMDD_HHMMSS_{well}_{rand6}).
 */
import { isFirebaseKeySafe } from './wbmPullAuthorize';

const FORBIDDEN_KEY = /[.#$\[\]\/]/;
const MINT_PACKET_ID = /^(\d{8})_(\d{6})_(.+)_([a-z0-9]{6})$/;
const FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 min allowed clock skew
const PAST_CEILING_MS = 30 * 24 * 60 * 60 * 1000; // 30 days max age

export const WATCHDOG_COMMERCIAL_FORBIDDEN = [
  'ticketNumber', 'invoiceNumber', 'invoiceDocId', 'dispatchId', 'jid', 'JID',
  'ticket', 'invoice', 'payroll', 'billing', 'shiftId', 'shift', 'jobId',
  'canonicalJobId', 'customerId', 'customerBilling', 'originAppContext',
  'invoicingMode', 'wbT', 'wbt', 'wbP', 'wbp', 'wbB', 'wbb', 'wbS', 'wbs',
  'wbE', 'wbe', 'jsa', 'JSA', 'driverId', 'createTicket',
] as const;

export const WATCHDOG_AFR_FORBIDDEN = [
  'afr', 'AFR', 'flowRate', 'timeTillPull', 'bbls24hrs', 'nextPullTime', 'currentLevel',
] as const;

export interface WatchdogPullInput {
  packetId?: unknown;
  wellName?: unknown;
  dateTimeUTC?: unknown;
  dateTime?: unknown;
  timezone?: unknown;
  tankLevelFeet?: unknown;
  bblsTaken?: unknown;
  idempotencyKey?: unknown;
  requestType?: unknown;
  wellDown?: unknown;
  wellDownIsAuthoritative?: unknown;
  predictedLevelInches?: unknown;

  // Provenance / candidate notes (WhatsApp Watchdog sidecar metadata)
  chat?: unknown;
  sender?: unknown;
  eventTimeLocal?: unknown;
  observedUtc?: unknown;
  top?: unknown;
  bottom?: unknown;
  explicitBbl?: unknown;
  parserVersion?: unknown;
  digest?: unknown;
  evidenceRef?: unknown;
  watchdogProvenance?: unknown;
}

export interface WatchdogPullContext {
  actorUid: string;
  companyId: string;
  nowMs: number;
}

export interface WatchdogPullNormalized {
  packetId: string;
  wellName: string;
  dateTimeUTC: string;
  dateTime: string;
  timezone: string;
  tankLevelFeet: number;
  bblsTaken: number;
  idempotencyKey: string;
  wellDown: boolean;
  watchdogProvenance?: Record<string, unknown>;
}

export type WatchdogPullValidation =
  | { ok: false; reason: string; message: string }
  | { ok: true; value: WatchdogPullNormalized };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/**
 * Fail-closed validation for Watchdog pulls.
 * companyId is server-authoritative from ctx, client override is forbidden.
 */
export function validateWatchdogPull(input: WatchdogPullInput, ctx: WatchdogPullContext): WatchdogPullValidation {
  if (!ctx.companyId) {
    return { ok: false, reason: 'company_required', message: 'No company is bound to your account.' };
  }
  if (!ctx.actorUid) {
    return { ok: false, reason: 'unauthenticated', message: 'Sign in to record a pull.' };
  }

  // Hard rejection: client-supplied companyId override
  if ('companyId' in (input as Record<string, unknown>)) {
    return { ok: false, reason: 'company_override_forbidden', message: 'Company is server-controlled and cannot be overridden.' };
  }

  // Hard rejection: commercial fields
  for (const bad of WATCHDOG_COMMERCIAL_FORBIDDEN) {
    if (bad in (input as Record<string, unknown>)) {
      return { ok: false, reason: 'commercial_fields_forbidden', message: `Field ${bad} is not permitted on a Watchdog pull.` };
    }
  }

  // Hard rejection: AFR alteration fields
  for (const bad of WATCHDOG_AFR_FORBIDDEN) {
    if (bad in (input as Record<string, unknown>)) {
      return { ok: false, reason: 'afr_fields_forbidden', message: `Field ${bad} cannot be sent; observations only.` };
    }
  }

  // Request type
  const requestType = str(input.requestType) || 'pull';
  if (requestType !== 'pull') {
    return { ok: false, reason: 'unsupported_request_type', message: 'Only pull requestType is supported.' };
  }

  // Well name
  const wellName = str(input.wellName);
  if (!wellName || wellName.length > 120) {
    return { ok: false, reason: 'wellName_invalid', message: 'Choose a valid well name.' };
  }
  if (FORBIDDEN_KEY.test(wellName)) {
    return { ok: false, reason: 'wellName_malformed', message: 'Well name contains unsupported characters.' };
  }

  // Packet ID
  const packetId = str(input.packetId);
  if (!packetId || !isFirebaseKeySafe(packetId)) {
    return { ok: false, reason: 'packetId_invalid', message: 'Valid packetId is required.' };
  }
  const mintMatch = MINT_PACKET_ID.exec(packetId);
  if (!mintMatch) {
    return { ok: false, reason: 'packetId_shape_invalid', message: 'packetId must match standard mint shape.' };
  }
  const cleanWell = wellName.replace(/\s+/g, '');
  if (mintMatch[3] !== cleanWell) {
    return { ok: false, reason: 'packetId_well_mismatch', message: 'packetId well component does not match wellName.' };
  }

  // Tank level (feet)
  const tankLevelFeet = num(input.tankLevelFeet ?? input.top);
  if (!Number.isFinite(tankLevelFeet) || tankLevelFeet < 0 || tankLevelFeet > 60) {
    return { ok: false, reason: 'tankLevelFeet_invalid', message: 'Enter a valid tank level in feet (0 - 60).' };
  }

  // Barrels taken
  const bblsTaken = num(input.bblsTaken ?? input.explicitBbl);
  if (!Number.isFinite(bblsTaken) || bblsTaken < 0 || bblsTaken > 100000) {
    return { ok: false, reason: 'bblsTaken_invalid', message: 'Enter a valid barrels value (0 - 100000).' };
  }

  // Date/time UTC
  const dateTimeUTC = str(input.dateTimeUTC ?? input.observedUtc);
  const ts = dateTimeUTC ? Date.parse(dateTimeUTC) : NaN;
  if (!dateTimeUTC || Number.isNaN(ts)) {
    return { ok: false, reason: 'dateTimeUTC_invalid', message: 'Valid UTC timestamp is required.' };
  }
  if (ts > ctx.nowMs + FUTURE_SKEW_MS) {
    return { ok: false, reason: 'dateTimeUTC_future', message: 'Pull time cannot be in the future.' };
  }
  if (ts < ctx.nowMs - PAST_CEILING_MS) {
    return { ok: false, reason: 'dateTimeUTC_implausibly_old', message: 'Pull time is older than the allowed 30-day window.' };
  }

  const timezone = str(input.timezone) || 'America/Chicago';
  const dateTime = str(input.dateTime) || new Date(ts).toLocaleString('en-US', { timeZone: timezone });

  const idempotencyKey = str(input.idempotencyKey) || packetId;
  if (!isFirebaseKeySafe(idempotencyKey)) {
    return { ok: false, reason: 'idempotencyKey_malformed', message: 'idempotencyKey contains invalid characters.' };
  }

  // Optional watchdog provenance metadata
  let watchdogProvenance: Record<string, unknown> | undefined;
  const rawProv = (input.watchdogProvenance && typeof input.watchdogProvenance === 'object')
    ? (input.watchdogProvenance as Record<string, unknown>)
    : null;

  const chat = str(input.chat ?? rawProv?.chat);
  const sender = str(input.sender ?? rawProv?.sender);
  const eventTimeLocal = str(input.eventTimeLocal ?? rawProv?.eventTimeLocal);
  const observedUtc = str(input.observedUtc ?? rawProv?.observedUtc);
  const top = num(input.top ?? rawProv?.top);
  const bottom = num(input.bottom ?? rawProv?.bottom);
  const explicitBbl = num(input.explicitBbl ?? rawProv?.explicitBbl);
  const parserVersion = str(input.parserVersion ?? rawProv?.parserVersion);
  const digest = str(input.digest ?? rawProv?.digest);
  const evidenceRef = str(input.evidenceRef ?? rawProv?.evidenceRef);

  if (chat || sender || eventTimeLocal || parserVersion || digest || Number.isFinite(bottom)) {
    watchdogProvenance = {
      ...(chat ? { chat } : {}),
      ...(sender ? { sender } : {}),
      ...(eventTimeLocal ? { eventTimeLocal } : {}),
      ...(observedUtc ? { observedUtc } : {}),
      ...(Number.isFinite(top) ? { top } : {}),
      ...(Number.isFinite(bottom) ? { bottom } : {}),
      ...(Number.isFinite(explicitBbl) ? { explicitBbl } : {}),
      ...(parserVersion ? { parserVersion } : {}),
      ...(digest ? { digest } : {}),
      ...(evidenceRef ? { evidenceRef } : {}),
    };
  }

  return {
    ok: true,
    value: {
      packetId,
      wellName,
      dateTimeUTC,
      dateTime,
      timezone,
      tankLevelFeet,
      bblsTaken,
      idempotencyKey,
      wellDown: input.wellDown === true,
      ...(watchdogProvenance ? { watchdogProvenance } : {}),
    },
  };
}

/**
 * Strict invariant check: never allow commercial fields or driver identity.
 */
export function assertNoCommercialProjection(packet: Record<string, unknown>): void {
  for (const bad of WATCHDOG_COMMERCIAL_FORBIDDEN) {
    if (bad in packet) throw new Error(`watchdog_pull_forbidden_field:${bad}`);
  }
}

/**
 * Builds the canonical WB-M incoming packet.
 * Carries originAppContext='wbm', source='watchdog', origin='watchdog-sidecar',
 * and NO driverId / commercial context.
 */
export function buildWatchdogPullPacket(
  value: WatchdogPullNormalized,
  ctx: WatchdogPullContext,
): {
  packetId: string;
  packet: Record<string, unknown>;
} {
  const packet: Record<string, unknown> = {
    packetId: value.packetId,
    idempotencyKey: value.idempotencyKey,
    requestType: 'pull',
    wellName: value.wellName,
    tankLevelFeet: value.tankLevelFeet,
    bblsTaken: value.bblsTaken,
    dateTimeUTC: value.dateTimeUTC,
    dateTime: value.dateTime,
    timezone: value.timezone,
    wellDown: value.wellDown,
    wellDownIsAuthoritative: true,
    companyId: ctx.companyId,
    source: 'watchdog',
    origin: 'watchdog-sidecar',
    driverName: 'WhatsApp Watchdog',
    ingestedAtUtc: new Date(ctx.nowMs).toISOString(),
    ingestedByUid: ctx.actorUid,
  };

  if (value.watchdogProvenance) {
    packet.watchdogProvenance = value.watchdogProvenance;
  }

  assertNoCommercialProjection(packet);

  return {
    packetId: value.packetId,
    packet,
  };
}
