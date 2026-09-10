/**
 * Washout / operational well-event contract (PURE validation + record build).
 *
 * The event is the ONLY thing that may later anchor a washout recovery window.
 * It must be recorded through a governed, authenticated callable — never a direct
 * client write and never a weakened rule. Identity is CANONICAL companyId +
 * wellId (never the display wellName). Writes are idempotent by eventId. The
 * server stamps its own recording time + recorder identity; occurredAtUtc is the
 * operational moment. Company IANA timezone is read from config, never hardcoded.
 */

export interface WellEventInput {
  eventId: string;                 // idempotency key (stable, client-supplied)
  companyId: string;               // CANONICAL company id (not a display name)
  wellId: string;                  // CANONICAL well id (not the display wellName)
  type: 'hot_oiler_washout';
  occurredAtUtc: number;           // ms epoch — when the washout happened
  freshBbls?: number;              // optional injected fresh-water volume
  saltBbls?: number;               // optional injected salt-water volume
  note?: string;                   // optional free text
}

export interface WellEventRecord extends WellEventInput {
  serverRecordedAtUtc: number;     // server-authoritative record time
  recordedBy: string;              // caller uid
  schemaVersion: 1;
}

export interface EventCaller {
  uid?: string;
  companyId?: string;              // caller's bound company (from requireManageDrivers)
  isPlatformAdmin?: boolean;
}

export type WellEventDecision =
  | { ok: true; record: WellEventRecord; path: string }
  | { ok: false; code: 'unauthenticated' | 'permission-denied' | 'invalid-argument'; reason: string };

const CANONICAL_ID_RE = /^[A-Za-z0-9_.:@+-]{1,120}$/; // ids, never a spaced display name
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000;

/**
 * Validate the input against the governed contract and, if valid, build the
 * record to persist at `path`. Deterministic given `serverNowMs`. Idempotency
 * itself is enforced at the store (create-if-absent on `path`).
 */
export function validateAndBuildWellEvent(
  input: WellEventInput,
  caller: EventCaller,
  serverNowMs: number,
): WellEventDecision {
  if (!caller || !caller.uid) return { ok: false, code: 'unauthenticated', reason: 'auth_required' };

  const eventId = String(input?.eventId || '').trim();
  const companyId = String(input?.companyId || '').trim();
  const wellId = String(input?.wellId || '').trim();

  if (!CANONICAL_ID_RE.test(eventId)) return { ok: false, code: 'invalid-argument', reason: 'event_id_malformed' };
  if (!CANONICAL_ID_RE.test(companyId)) return { ok: false, code: 'invalid-argument', reason: 'company_id_malformed_or_display_name' };
  // A spaced value is a display wellName, not a canonical id → reject explicitly.
  if (!CANONICAL_ID_RE.test(wellId)) return { ok: false, code: 'invalid-argument', reason: 'well_id_malformed_or_display_name' };

  // Governance: caller must manage THIS company (or be a platform admin).
  if (!caller.isPlatformAdmin && caller.companyId !== companyId) {
    return { ok: false, code: 'permission-denied', reason: 'company_scope_mismatch' };
  }

  if (input.type !== 'hot_oiler_washout') return { ok: false, code: 'invalid-argument', reason: 'unsupported_event_type' };

  if (!Number.isFinite(input.occurredAtUtc) || input.occurredAtUtc <= 0) {
    return { ok: false, code: 'invalid-argument', reason: 'occurred_at_invalid' };
  }
  if (input.occurredAtUtc > serverNowMs + MAX_FUTURE_MS) {
    return { ok: false, code: 'invalid-argument', reason: 'occurred_at_in_future' };
  }

  for (const [k, v] of [['freshBbls', input.freshBbls], ['saltBbls', input.saltBbls]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || (v as number) < 0)) {
      return { ok: false, code: 'invalid-argument', reason: `${k}_invalid` };
    }
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) {
    return { ok: false, code: 'invalid-argument', reason: 'note_invalid' };
  }

  const record: WellEventRecord = {
    eventId, companyId, wellId, type: 'hot_oiler_washout',
    occurredAtUtc: input.occurredAtUtc,
    ...(input.freshBbls !== undefined ? { freshBbls: input.freshBbls } : {}),
    ...(input.saltBbls !== undefined ? { saltBbls: input.saltBbls } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    serverRecordedAtUtc: serverNowMs,
    recordedBy: caller.uid,
    schemaVersion: 1,
  };
  return { ok: true, record, path: `well_events/${companyId}/${wellId}/${eventId}` };
}
