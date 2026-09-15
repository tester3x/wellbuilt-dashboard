/**
 * Deep-link / refresh state durability — pure, Firebase-free, node-testable core.
 *
 * Precedence (highest first):
 *   1. URL / deep link (pathname + query + hash) — navigational truth
 *   2. Session state scoped to authenticated UID + companyId + pathname — ephemeral
 *      presentation (expanded groups, scroll, sort, pagination, selection)
 *   3. Screen defaults
 *
 * Scoping rule: every session key embeds uid + companyId + pathname, so state from
 * another user or company is NEVER read back (different key ⇒ miss ⇒ defaults). This
 * is the cross-company / cross-user isolation guarantee, enforced by construction.
 *
 * Identity rule: presentation state keys on CANONICAL ids only — canonical driverId
 * for driver groups, document id for jobs, canonical well key for wells — NEVER a
 * display name, login name, or list index.
 */

export interface DeepLinkScope {
  uid: string | null | undefined;
  companyId: string | null | undefined;
  pathname: string;
}

const STATE_VERSION = 'v1';

/** Sanitize a key segment so ':' / whitespace can't collide across segments. */
function seg(v: string | null | undefined): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  return s.trim().replace(/[:\s]+/g, '_') || '-';
}

/**
 * Session-storage key for one presentation slot on one screen for one identity.
 * Format: `dl:v1:{uid}:{companyId}:{pathname}:{slot}`. A missing uid/companyId
 * uses '-' so anonymous/admin scopes never collide with a real tenant.
 */
export function buildDeepLinkStateKey(scope: DeepLinkScope, slot: string): string {
  return ['dl', STATE_VERSION, seg(scope.uid), seg(scope.companyId), seg(scope.pathname), seg(slot)].join(':');
}

/** True only when the scope is complete enough to safely persist/restore (both UID and companyId resolved, neither '-'). */
export function scopeReady(scope: DeepLinkScope): boolean {
  return !!(
    scope &&
    typeof scope.pathname === 'string' &&
    scope.pathname.length > 0 &&
    typeof scope.uid === 'string' &&
    scope.uid.trim().length > 0 &&
    scope.uid.trim() !== '-' &&
    typeof scope.companyId === 'string' &&
    scope.companyId.trim().length > 0 &&
    scope.companyId.trim() !== '-'
  );
}

export interface PersistedEnvelope<T> {
  v: typeof STATE_VERSION;
  uid: string;
  companyId: string;
  pathname: string;
  slot: string;
  data: T;
  savedAt: number;
}

export function serializeState<T>(scope: DeepLinkScope, slot: string, data: T, nowMs: number): string {
  const env: PersistedEnvelope<T> = {
    v: STATE_VERSION,
    uid: seg(scope.uid),
    companyId: seg(scope.companyId),
    pathname: seg(scope.pathname),
    slot: seg(slot),
    data,
    savedAt: nowMs,
  };
  return JSON.stringify(env);
}

/**
 * Parse a stored envelope, returning its data ONLY when it belongs to the current
 * scope+slot (defence in depth beyond the key). Cross-company/user/route mismatch,
 * version drift, placeholder '-' envelope, or corruption ⇒ null (fall through to defaults).
 */
export function parseState<T>(raw: string | null | undefined, scope: DeepLinkScope, slot: string): T | null {
  if (!raw || !scopeReady(scope)) return null;
  let env: PersistedEnvelope<T>;
  try {
    env = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!env || env.v !== STATE_VERSION) return null;
  if (env.uid === '-' || env.companyId === '-') return null;
  if (env.uid !== seg(scope.uid)) return null;
  if (env.companyId !== seg(scope.companyId)) return null;
  if (env.pathname !== seg(scope.pathname)) return null;
  if (env.slot !== seg(slot)) return null;
  return env.data;
}

/**
 * Resolve the initial value for a navigational slot using the precedence rule.
 * `url` wins when present (deep link is truth); else session; else default.
 * `urlPresent` distinguishes "URL explicitly set this" from "absent".
 */
export function resolveInitialState<T>(input: {
  url?: { present: boolean; value: T };
  session?: T | null;
  fallback: T;
}): { value: T; source: 'url' | 'session' | 'default' } {
  if (input.url && input.url.present) return { value: input.url.value, source: 'url' };
  if (input.session != null) return { value: input.session, source: 'session' };
  return { value: input.fallback, source: 'default' };
}

/**
 * Drop a restored SELECTION that no longer points at a live entity (deleted job/well).
 * Returns null when the id is absent or not in the currently-valid id set — so a
 * refresh drops ONLY the stale selection, never the rest of the screen.
 */
export function restorableSelection(
  selectedId: string | null | undefined,
  validIds: Iterable<string>,
): string | null {
  const id = typeof selectedId === 'string' ? selectedId.trim() : '';
  if (!id) return null;
  const set = validIds instanceof Set ? validIds : new Set(validIds);
  return set.has(id) ? id : null;
}

/**
 * Keep only canonical group ids that still exist. A restored expanded-group set is
 * intersected with the live canonical ids, so groups for departed drivers silently
 * drop without collapsing the groups that remain.
 */
export function restorableIdSet(
  storedIds: Iterable<string> | null | undefined,
  liveIds: Iterable<string>,
): string[] {
  if (!storedIds) return [];
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const out: string[] = [];
  for (const raw of storedIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && live.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Slots that must NEVER be restored (destructive dialogs, unsaved form mutations). */
export const NON_RESTORABLE_SLOTS = new Set<string>([
  'confirmDialog',
  'deleteConfirm',
  'unsavedForm',
  'formDraft',
]);

export function isRestorableSlot(slot: string): boolean {
  return !NON_RESTORABLE_SLOTS.has(slot);
}
