/**
 * Pure core for the governed Dashboard Dispatch MANUAL pull (+Add Pull).
 *
 * Authorized by DISPATCH-WRITE security (createDispatch capability) — a dispatch
 * manager/admin records water moved by hot oilers, washout/service crews,
 * third-party haulers, and anyone NOT using WB-M/WB-T. It records a WB-M
 * level/history pull ONLY: the packet carries no invoice/dispatch/ticket
 * invoicing context, so processIncomingPull produces no ticket/invoice/Payroll/
 * Billing projection. AFR logic is untouched (ordinary requestType:'pull').
 *
 * Actor model: the authenticated DISPATCHER is recorded via actorType/source +
 * dispatchActorUid and audited separately. The entry is NEVER represented as a
 * real driver (no driverId:manual:<uid>); an optional EXTERNAL driver/company is
 * display-only metadata that can never map to a real WB-M driver or Payroll.
 * A real dispatch link is optional, recorded as linkedDispatchId (never the
 * invoicing-trigger `dispatchId` field).
 *
 * No firebase imports here so the invariants unit-test without an emulator.
 */

export const MANUAL_PULL_SERVICE_CATEGORIES = [
  'standard',
  'hot_oiler',
  'washout',
  'third_party',
  'other',
] as const;
export type ManualPullServiceCategory = (typeof MANUAL_PULL_SERVICE_CATEGORIES)[number];

/** Fixed, non-driver actor markers. */
export const MANUAL_PULL_ACTOR_TYPE = 'dashboard_dispatch';
export const MANUAL_PULL_SOURCE = 'dashboard_dispatch_manual';
export const MANUAL_PULL_ENTRY_KIND = 'manual_dispatch';

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
  /** Optional link to an EXISTING dispatch. Never the invoicing-trigger field. */
  linkedDispatchId?: unknown;
}

export interface ManualPullContext {
  actorUid: string; // the authenticated DISPATCHER — audited separately
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
  linkedDispatchId: string;
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
  // The invoicing-trigger dispatchId field is never accepted (only linkedDispatchId).
  if ('dispatchId' in (input as Record<string, unknown>)) {
    return { ok: false, reason: 'dispatchId_forbidden', message: 'Use linkedDispatchId to reference a dispatch.' };
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

  const linkedDispatchId = str(input.linkedDispatchId);
  if (linkedDispatchId && (linkedDispatchId.length > 200 || FORBIDDEN_KEY.test(linkedDispatchId))) {
    return { ok: false, reason: 'linkedDispatchId_malformed', message: 'Dispatch reference is malformed.' };
  }

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
      serviceCategory, externalCompany, externalDriver, reason, idempotencyKey, timezone, linkedDispatchId,
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
 * Build the packet written to packets/incoming. Carries NO invoiceDocId /
 * dispatchId / invoicingMode / originAppContext, so processIncomingPull records
 * the pull for WB-M level/history and produces no ticket/invoice. The actor is
 * the DISPATCHER (actorType/source/dispatchActorUid) — never a driver.
 */
export function buildManualPullPacket(value: ManualPullNormalized, ctx: ManualPullContext): {
  packetId: string;
  packet: Record<string, unknown>;
} {
  const packetId = manualPacketId(value);
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
    // ── dispatch-manual actor metadata (NEVER a real driver / never Payroll) ──
    manualEntry: true,
    actorType: MANUAL_PULL_ACTOR_TYPE,
    source: MANUAL_PULL_SOURCE,
    entryKind: MANUAL_PULL_ENTRY_KIND,
    dispatchActorUid: ctx.actorUid, // the authenticated dispatcher — audited separately
    serviceCategory: value.serviceCategory,
    idempotencyKey: value.idempotencyKey,
    ingestedAtUtc: ctx.nowMs,
    // display-only label; clearly not a WB-M driver
    driverName: value.externalDriver ? `${value.externalDriver} (external)` : 'Dispatch Manual Entry',
  };
  if (value.externalCompany) packet.externalCompany = value.externalCompany;
  if (value.externalDriver) packet.externalDriver = value.externalDriver; // display metadata only
  if (value.reason) packet.reason = value.reason;
  // Optional link to an existing dispatch — recorded as metadata, NOT the
  // invoicing-trigger `dispatchId` field (so no invoice/ticket is created).
  if (value.linkedDispatchId) packet.linkedDispatchId = value.linkedDispatchId;
  return { packetId, packet };
}

/**
 * Guard: a manual packet must never carry ticket/invoice/dispatch INVOICING
 * projection context, and must never carry a driver-shaped actor id.
 */
export function assertNoCommercialProjection(packet: Record<string, unknown>): void {
  for (const k of ['invoiceDocId', 'dispatchId', 'invoicingMode', 'originAppContext', 'createTicket', 'ticketNumber']) {
    if (k in packet) throw new Error(`manual_pull_forbidden_field:${k}`);
  }
  // The dispatcher must never be represented as a real driver.
  if ('driverId' in packet) throw new Error('manual_pull_forbidden_field:driverId');
}
