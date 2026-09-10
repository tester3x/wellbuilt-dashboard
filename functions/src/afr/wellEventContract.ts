/**
 * Washout / operational well-event contract (PURE validation + record build +
 * idempotency + void reconciliation).
 *
 * IDENTITY (proven against production, not assumed):
 *   - There is NO separate canonical wellId. Wells are keyed by their wellName in
 *     companyWells/{companyId}/{wellName}, well_config, and packets. So the well
 *     key here IS the wellName ("Gabriel 4", "33-053-04319-00-00", ...). We
 *     validate it as an RTDB-key-safe token (spaces allowed; ./#/$/[/] forbidden).
 *   - companyId is a slug (e.g. "liquid-gold").
 *   - Company timezone is server-resolved (companies/{companyId}.timezone, else a
 *     documented state->IANA fallback) and PERSISTED as a snapshot. liquid-gold
 *     currently has no timezone field (state "ND"): see resolveTimeZoneForState.
 *
 * Recorded only through a governed authenticated callable. Idempotent by
 * eventId+payloadDigest (same payload = idempotent; different = CONFLICT). A void
 * is an auditable overlay (voidedAt/voidedBy/voidReason) — the original is never
 * deleted, and a voided event never activates AFR.
 */
import { createHash } from 'crypto';

export interface WellEventInput {
  eventId: string;                 // idempotency key (stable, client-supplied)
  companyId: string;               // company slug (canonical)
  wellKey: string;                 // the well's key = its wellName (no separate wellId exists)
  type: 'hot_oiler_washout';
  occurredAtUtc: number;           // ms epoch — when the washout happened (required)
  freshWaterBbls?: number;
  saltWaterBbls?: number;
  note?: string;
}

export type RecorderRole = 'driver' | 'manager' | 'platform';

export interface WellEventRecord extends WellEventInput {
  serverRecordedAtUtc: number;
  recordedBy: string;
  recordedByRole: RecorderRole;
  ianaTimezoneSnapshot: string;    // server-resolved + persisted company tz
  payloadDigest: string;           // idempotent-vs-conflict discriminator
  schemaVersion: 1;
  // Void overlay (absent until voided; original fields never mutated/deleted):
  voidedAtUtc?: number;
  voidedBy?: string;
  voidReason?: string;
}

export interface EventCaller {
  uid?: string;
  companyId?: string;
  isPlatformAdmin?: boolean;
  role?: RecorderRole;
}

export interface EventContext {
  serverNowMs: number;
  timeZone: string;                // server-resolved company IANA tz (persisted)
  wellExists: boolean;             // caller proved companyWells/{companyId}/{wellKey} exists
}

export type WellEventDecision =
  | { ok: true; record: WellEventRecord; path: string }
  | { ok: false; code: 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'not-found'; reason: string };

const COMPANY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i; // slug
// RTDB-key-safe well key: forbids . $ # [ ] / and control chars; trims required.
const WELL_KEY_RE = /^[^.$#/\[\]\x00-\x1f]{1,256}$/;
const IANA_TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000;

/** Documented state->IANA fallback when a company has no explicit timezone.
 *  Per-company (via the company's own state) — NOT a global hardcode. Returns ''
 *  for unknown states so the contract fails closed (timezone_unresolved). */
export function resolveTimeZoneForState(state: unknown): string {
  const map: Record<string, string> = {
    ND: 'America/Chicago', SD: 'America/Chicago', MN: 'America/Chicago', TX: 'America/Chicago',
    MT: 'America/Denver', WY: 'America/Denver', CO: 'America/Denver', NM: 'America/Denver',
    OK: 'America/Chicago', KS: 'America/Chicago', NE: 'America/Chicago',
  };
  return typeof state === 'string' ? map[state.trim().toUpperCase()] || '' : '';
}

export function wellEventPayloadDigest(input: WellEventInput): string {
  const canonical = JSON.stringify([
    'hot_oiler_washout',
    String(input.companyId || '').trim(),
    String(input.wellKey || '').trim(),
    String(input.eventId || '').trim(),
    Number(input.occurredAtUtc),
    input.freshWaterBbls ?? null,
    input.saltWaterBbls ?? null,
    input.note ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function validateAndBuildWellEvent(
  input: WellEventInput,
  caller: EventCaller,
  ctx: EventContext,
): WellEventDecision {
  if (!caller || !caller.uid) return { ok: false, code: 'unauthenticated', reason: 'auth_required' };

  const eventId = String(input?.eventId || '').trim();
  const companyId = String(input?.companyId || '').trim();
  const wellKey = String(input?.wellKey || '').trim();

  if (!COMPANY_ID_RE.test(eventId) && !WELL_KEY_RE.test(eventId)) return { ok: false, code: 'invalid-argument', reason: 'event_id_malformed' };
  if (!COMPANY_ID_RE.test(companyId)) return { ok: false, code: 'invalid-argument', reason: 'company_id_malformed' };
  if (!wellKey || !WELL_KEY_RE.test(wellKey)) {
    return { ok: false, code: 'invalid-argument', reason: 'well_key_malformed' };
  }

  if (!caller.isPlatformAdmin && caller.companyId !== companyId) {
    return { ok: false, code: 'permission-denied', reason: 'company_scope_mismatch' };
  }
  if (!ctx.wellExists) return { ok: false, code: 'not-found', reason: 'well_not_found_in_company' };

  if (input.type !== 'hot_oiler_washout') return { ok: false, code: 'invalid-argument', reason: 'unsupported_event_type' };
  if (!Number.isFinite(input.occurredAtUtc) || input.occurredAtUtc <= 0) {
    return { ok: false, code: 'invalid-argument', reason: 'occurred_at_missing_or_invalid' };
  }
  if (input.occurredAtUtc > ctx.serverNowMs + MAX_FUTURE_MS) {
    return { ok: false, code: 'invalid-argument', reason: 'occurred_at_in_future' };
  }
  if (!IANA_TZ_RE.test(ctx.timeZone)) return { ok: false, code: 'invalid-argument', reason: 'timezone_unresolved' };

  for (const [k, v] of [['freshWaterBbls', input.freshWaterBbls], ['saltWaterBbls', input.saltWaterBbls]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || (v as number) < 0)) {
      return { ok: false, code: 'invalid-argument', reason: `${k}_invalid` };
    }
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) {
    return { ok: false, code: 'invalid-argument', reason: 'note_invalid' };
  }

  const cleanInput: WellEventInput = {
    eventId, companyId, wellKey, type: 'hot_oiler_washout', occurredAtUtc: input.occurredAtUtc,
    ...(input.freshWaterBbls !== undefined ? { freshWaterBbls: input.freshWaterBbls } : {}),
    ...(input.saltWaterBbls !== undefined ? { saltWaterBbls: input.saltWaterBbls } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  const record: WellEventRecord = {
    ...cleanInput,
    serverRecordedAtUtc: ctx.serverNowMs,
    recordedBy: caller.uid,
    recordedByRole: caller.role || (caller.isPlatformAdmin ? 'platform' : 'manager'),
    ianaTimezoneSnapshot: ctx.timeZone,
    payloadDigest: wellEventPayloadDigest(cleanInput),
    schemaVersion: 1,
  };
  return { ok: true, record, path: `well_events/${companyId}/${encodeRtdbKey(wellKey)}/${eventId}` };
}

/** RTDB keys allow spaces but not . $ # [ ] / — the well key is already validated
 *  to exclude those, so it is used verbatim. (Exposed for the consumer to build
 *  the identical read path.) */
export function encodeRtdbKey(key: string): string {
  return key;
}

/** A voided event never activates AFR. */
export function isWellEventActive(rec: Pick<WellEventRecord, 'voidedAtUtc'>): boolean {
  return !rec.voidedAtUtc;
}

export type IdempotencyOutcome =
  | { action: 'create' }
  | { action: 'idempotent' }
  | { action: 'conflict'; reason: string };

export function reconcileWellEventIdempotency(
  existing: { payloadDigest?: string } | null | undefined,
  incomingDigest: string,
): IdempotencyOutcome {
  if (!existing) return { action: 'create' };
  if (existing.payloadDigest === incomingDigest) return { action: 'idempotent' };
  return { action: 'conflict', reason: 'event_id_reused_with_different_payload' };
}

export type VoidOutcome =
  | { ok: true; action: 'void' | 'already_voided'; record: WellEventRecord }
  | { ok: false; code: 'not-found' | 'permission-denied' | 'invalid-argument'; reason: string };

/** Manager-only void as an auditable overlay; repeated void is idempotent. */
export function decideVoidWellEvent(
  existing: WellEventRecord | null | undefined,
  caller: EventCaller,
  ctx: { serverNowMs: number; reason?: string },
): VoidOutcome {
  if (!existing) return { ok: false, code: 'not-found', reason: 'event_not_found' };
  if (caller.role === 'driver') return { ok: false, code: 'permission-denied', reason: 'void_requires_manager' };
  if (!caller.isPlatformAdmin && caller.companyId !== existing.companyId) {
    return { ok: false, code: 'permission-denied', reason: 'company_scope_mismatch' };
  }
  if (existing.voidedAtUtc) return { ok: true, action: 'already_voided', record: existing };
  const record: WellEventRecord = {
    ...existing,
    voidedAtUtc: ctx.serverNowMs,
    voidedBy: caller.uid || 'unknown',
    voidReason: ctx.reason ? String(ctx.reason).slice(0, 500) : 'unspecified',
  };
  return { ok: true, action: 'void', record };
}
