/**
 * Washout / operational well-event contract (PURE validation + record build +
 * idempotency reconciliation).
 *
 * Recorded only through a governed, authenticated callable (never a direct
 * client write, never a weakened rule). Identity is CANONICAL companyId +
 * wellId (never the display wellName). The server resolves and PERSISTS the
 * company IANA timezone snapshot, stamps its own record time + recorder
 * identity/role, and enforces idempotency by eventId:
 *   - same eventId + identical payload  → idempotent retry (no change);
 *   - same eventId + different payload  → CONFLICT (never silent success).
 */
import { createHash } from 'crypto';

export interface WellEventInput {
  eventId: string;                 // idempotency key (stable, client-supplied)
  companyId: string;               // CANONICAL company id (not a display name)
  wellId: string;                  // CANONICAL well id (not the display wellName)
  type: 'hot_oiler_washout';
  occurredAtUtc: number;           // ms epoch — when the washout happened (required)
  freshWaterBbls?: number;         // optional injected fresh-water volume
  saltWaterBbls?: number;          // optional injected salt-water volume
  note?: string;
}

export type RecorderRole = 'driver' | 'manager' | 'platform';

export interface WellEventRecord extends WellEventInput {
  serverRecordedAtUtc: number;     // server-authoritative record time
  recordedBy: string;              // caller principal (driverId or uid)
  recordedByRole: RecorderRole;
  ianaTimezoneSnapshot: string;    // server-resolved + persisted company tz
  payloadDigest: string;           // idempotent-vs-conflict discriminator
  schemaVersion: 1;
}

export interface EventCaller {
  uid?: string;                    // authenticated principal id (driverId or uid)
  companyId?: string;              // caller's bound company
  isPlatformAdmin?: boolean;
  role?: RecorderRole;
}

export interface EventContext {
  serverNowMs: number;
  timeZone: string;                // server-resolved company IANA tz (persisted)
  wellExists: boolean;             // caller proved the canonical well exists in the company
}

export type WellEventDecision =
  | { ok: true; record: WellEventRecord; path: string }
  | { ok: false; code: 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'not-found'; reason: string };

const CANONICAL_ID_RE = /^[A-Za-z0-9_.:@+-]{1,120}$/; // ids, never a spaced display name
const IANA_TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000;

/** Canonical payload digest — the semantic identity of the event submission. */
export function wellEventPayloadDigest(input: WellEventInput): string {
  const canonical = JSON.stringify([
    'hot_oiler_washout',
    String(input.companyId || '').trim(),
    String(input.wellId || '').trim(),
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
  const wellId = String(input?.wellId || '').trim();

  if (!CANONICAL_ID_RE.test(eventId)) return { ok: false, code: 'invalid-argument', reason: 'event_id_malformed' };
  if (!CANONICAL_ID_RE.test(companyId)) return { ok: false, code: 'invalid-argument', reason: 'company_id_malformed_or_display_name' };
  if (!CANONICAL_ID_RE.test(wellId)) return { ok: false, code: 'invalid-argument', reason: 'well_id_malformed_or_display_name' };

  // Governance: company membership must be proven (driver/manager scoped to their
  // own company; a platform admin may act cross-company).
  if (!caller.isPlatformAdmin && caller.companyId !== companyId) {
    return { ok: false, code: 'permission-denied', reason: 'company_scope_mismatch' };
  }
  // Well existence must be proven by the caller (never trusted from the client).
  if (!ctx.wellExists) return { ok: false, code: 'not-found', reason: 'well_not_found_in_company' };

  if (input.type !== 'hot_oiler_washout') return { ok: false, code: 'invalid-argument', reason: 'unsupported_event_type' };

  if (!Number.isFinite(input.occurredAtUtc) || input.occurredAtUtc <= 0) {
    return { ok: false, code: 'invalid-argument', reason: 'occurred_at_missing_or_invalid' };
  }
  if (input.occurredAtUtc > ctx.serverNowMs + MAX_FUTURE_MS) {
    return { ok: false, code: 'invalid-argument', reason: 'occurred_at_in_future' };
  }
  if (!IANA_TZ_RE.test(ctx.timeZone)) {
    return { ok: false, code: 'invalid-argument', reason: 'timezone_unresolved' };
  }

  for (const [k, v] of [['freshWaterBbls', input.freshWaterBbls], ['saltWaterBbls', input.saltWaterBbls]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || (v as number) < 0)) {
      return { ok: false, code: 'invalid-argument', reason: `${k}_invalid` };
    }
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) {
    return { ok: false, code: 'invalid-argument', reason: 'note_invalid' };
  }

  const cleanInput: WellEventInput = {
    eventId, companyId, wellId, type: 'hot_oiler_washout', occurredAtUtc: input.occurredAtUtc,
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
  return { ok: true, record, path: `well_events/${companyId}/${wellId}/${eventId}` };
}

export type IdempotencyOutcome =
  | { action: 'create' }
  | { action: 'idempotent' }
  | { action: 'conflict'; reason: string };

/** Reconcile a repeated eventId against what is already stored. */
export function reconcileWellEventIdempotency(
  existing: { payloadDigest?: string } | null | undefined,
  incomingDigest: string,
): IdempotencyOutcome {
  if (!existing) return { action: 'create' };
  if (existing.payloadDigest === incomingDigest) return { action: 'idempotent' };
  return { action: 'conflict', reason: 'event_id_reused_with_different_payload' };
}
