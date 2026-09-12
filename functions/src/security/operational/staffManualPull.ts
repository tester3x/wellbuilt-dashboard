/**
 * Pure core for the governed dispatcher/admin MANUAL pull (+Add Pull).
 *
 * Accounts for water moved by hot oilers, washout/service crews, third-party
 * haulers, and anyone NOT using WB-M/WB-T. It records a WB-M level/history pull
 * ONLY — it never carries invoice/dispatch/ticket context, so processIncomingPull
 * produces no ticket/invoice/Payroll/Billing projection. AFR logic is untouched
 * (the packet is an ordinary requestType:'pull').
 *
 * No firebase imports here so validation, packet-shape, idempotency, and the
 * no-ticket / no-impersonation invariants unit-test without an emulator. The
 * callable (staffSubmitManualPullCallable.ts) supplies auth + the admin write.
 */

export const MANUAL_PULL_SERVICE_CATEGORIES = [
  'standard',
  'hot_oiler',
  'washout',
  'third_party',
  'other',
] as const;
export type ManualPullServiceCategory = (typeof MANUAL_PULL_SERVICE_CATEGORIES)[number];

const FORBIDDEN_KEY = /[.$#[\]/]/; // RTDB-path-unsafe chars
const MAX_STR = 200;
const FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes — matches the AFR event-time skew tolerance

/** Client-supplied input. companyId is NEVER accepted here — it is derived from auth. */
export interface ManualPullInput {
  wellName?: unknown;
  tankLevelFeet?: unknown;
  bblsTaken?: unknown;
  dateTimeUTC?: unknown;
  wellDown?: unknown;
  serviceCategory?: unknown;
  externalCompany?: unknown;
  externalDriver?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
  timezone?: unknown;
}

export interface ManualPullContext {
  actorUid: string;
  companyId: string; // derived from the authenticated caller — authoritative
  nowMs: number;
}

export interface ManualPullNormalized {
  wellName: string;
  tankLevelFeet: number;
  bblsTaken: number;
  dateTimeUTC: string;
  wellDown: boolean;
  serviceCategory: ManualPullServiceCategory;
  externalCompany: string;
  externalDriver: string;
  reason: string;
  idempotencyKey: string;
  timezone: string;
}

export type ManualPullValidation =
  | { ok: false; reason: string; message: string }
  | { ok: true; value: ManualPullNormalized };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** Fail-closed validation. companyId comes from ctx, never from input. */
export function validateManualPull(input: ManualPullInput, ctx: ManualPullContext): ManualPullValidation {
  if (!ctx.companyId) return { ok: false, reason: 'company_required', message: 'No company is bound to your account.' };
  if (!ctx.actorUid) return { ok: false, reason: 'unauthenticated', message: 'Sign in to record a pull.' };
  // A client-supplied companyId override is a hard error — never trusted.
  if ('companyId' in (input as Record<string, unknown>)) {
    return { ok: false, reason: 'company_override_forbidden', message: 'Company is derived from your account.' };
  }

  const wellName = str(input.wellName);
  if (!wellName || wellName.length > 120) return { ok: false, reason: 'wellName_invalid', message: 'Choose a valid well.' };
  if (FORBIDDEN_KEY.test(wellName)) return { ok: false, reason: 'wellName_malformed', message: 'Well name has unsupported characters.' };

  const tankLevelFeet = num(input.tankLevelFeet);
  if (!Number.isFinite(tankLevelFeet) || tankLevelFeet < 0 || tankLevelFeet > 60) {
    return { ok: false, reason: 'tankLevelFeet_invalid', message: 'Enter a valid tank level (feet).' };
  }
  const bblsTaken = num(input.bblsTaken);
  if (!Number.isFinite(bblsTaken) || bblsTaken < 0 || bblsTaken > 100000) {
    return { ok: false, reason: 'bblsTaken_invalid', message: 'Enter a valid barrels value.' };
  }

  const dateTimeUTC = str(input.dateTimeUTC);
  const ts = dateTimeUTC ? Date.parse(dateTimeUTC) : NaN;
  if (!dateTimeUTC || Number.isNaN(ts)) return { ok: false, reason: 'dateTimeUTC_invalid', message: 'Enter a valid pull date/time.' };
  if (ts > ctx.nowMs + FUTURE_SKEW_MS) return { ok: false, reason: 'dateTimeUTC_future', message: 'Pull time cannot be in the future.' };

  const rawCat = str(input.serviceCategory) || 'standard';
  if (!(MANUAL_PULL_SERVICE_CATEGORIES as readonly string[]).includes(rawCat)) {
    return { ok: false, reason: 'serviceCategory_invalid', message: 'Choose a valid service category.' };
  }
  const serviceCategory = rawCat as ManualPullServiceCategory;

  const externalCompany = str(input.externalCompany).slice(0, MAX_STR);
  const externalDriver = str(input.externalDriver).slice(0, MAX_STR);
  const reason = str(input.reason).slice(0, MAX_STR);
  const timezone = str(input.timezone).slice(0, 64) || 'America/Chicago';

  // Idempotency key: client-stable if provided (RTDB-key-safe), else derived.
  let idempotencyKey = str(input.idempotencyKey);
  if (idempotencyKey) {
    if (idempotencyKey.length > 120 || FORBIDDEN_KEY.test(idempotencyKey)) {
      return { ok: false, reason: 'idempotencyKey_malformed', message: 'Retry key is malformed.' };
    }
  } else {
    idempotencyKey = deriveIdempotencyKey({ wellName, dateTimeUTC, bblsTaken, actorUid: ctx.actorUid });
  }

  return {
    ok: true,
    value: {
      wellName, tankLevelFeet, bblsTaken, dateTimeUTC,
      wellDown: input.wellDown === true,
      serviceCategory, externalCompany, externalDriver, reason, idempotencyKey, timezone,
    },
  };
}

/** Stable, collision-resistant key for the same logical manual pull. */
export function deriveIdempotencyKey(a: { wellName: string; dateTimeUTC: string; bblsTaken: number; actorUid: string }): string {
  const basis = `${a.wellName}|${a.dateTimeUTC}|${a.bblsTaken}|${a.actorUid}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `k${h.toString(36)}`;
}

/** Canonical WB-M packet id for a manual pull — deterministic ⇒ idempotent retry. */
export function manualPacketId(value: ManualPullNormalized): string {
  const cleanWell = value.wellName.replace(/\s/g, '');
  return `manual_${value.idempotencyKey}_${cleanWell}`;
}

/**
 * Build the packet written to packets/incoming. Deliberately carries NO
 * invoiceDocId / dispatchId / invoicingMode / originAppContext, so
 * processIncomingPull records the pull for WB-M level/history and produces no
 * ticket/invoice. driverId is a synthetic staff marker — never a real driver id.
 */
export function buildManualPullPacket(value: ManualPullNormalized, ctx: ManualPullContext): {
  packetId: string;
  packet: Record<string, unknown>;
} {
  const packetId = manualPacketId(value);
  const label =
    value.externalDriver
      ? value.externalDriver
      : `Manual Entry (${value.serviceCategory.replace(/_/g, ' ')})`;
  const packet: Record<string, unknown> = {
    packetId,
    wellName: value.wellName,
    tankLevelFeet: value.tankLevelFeet,
    bblsTaken: value.bblsTaken,
    dateTimeUTC: value.dateTimeUTC,
    dateTime: new Date(value.dateTimeUTC).toLocaleString('en-US', { timeZone: value.timezone }),
    requestType: 'pull',
    wellDown: value.wellDown,
    wellDownIsAuthoritative: true,
    timezone: value.timezone,
    // company is authoritative from the caller; never a client override
    companyId: ctx.companyId,
    // synthetic, non-driver identity — no impersonation of any real WB-M/WB-T driver
    driverId: `manual:${ctx.actorUid}`,
    driverName: label,
    // manual-entry provenance / audit
    manualEntry: true,
    source: 'dashboard_manual',
    staffActorUid: ctx.actorUid,
    serviceCategory: value.serviceCategory,
    idempotencyKey: value.idempotencyKey,
    ingestedAtUtc: ctx.nowMs,
  };
  if (value.externalCompany) packet.externalCompany = value.externalCompany;
  if (value.externalDriver) packet.externalDriver = value.externalDriver;
  if (value.reason) packet.reason = value.reason;
  return { packetId, packet };
}

/** Guard: a manual packet must never carry ticket/invoice/dispatch projection context. */
export function assertNoCommercialProjection(packet: Record<string, unknown>): void {
  for (const k of ['invoiceDocId', 'dispatchId', 'invoicingMode', 'originAppContext', 'createTicket', 'ticketNumber']) {
    if (k in packet) throw new Error(`manual_pull_forbidden_field:${k}`);
  }
}
