/**
 * Collision-safe well materialization signal.
 *
 * packets/incoming_version is a legacy global counter. Production currently
 * holds ~4.3e20, beyond Number.MAX_SAFE_INTEGER, so `n + 1 === n` and
 * listeners never see a change. Do NOT reset that path.
 *
 * New path (per company/well, string event id):
 *   packets/materialized/{companyId}/{wellKey}
 * Written AFTER outgoing/status materialization (pull, edit, delete).
 */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export type MaterializedKind = 'pull' | 'edit' | 'delete' | 'status';

export interface MaterializedEvent {
  eventId: string;
  packetId: string | null;
  wellName: string;
  companyId: string;
  kind: MaterializedKind;
  atMs: number;
}

export function isUnsafeVersionNumber(current: unknown): boolean {
  const n = typeof current === 'number' ? current : Number(current);
  if (!Number.isFinite(n)) return true;
  return n > MAX_SAFE || n + 1 === n;
}

/**
 * Legacy +1. If the stored value cannot represent +1, return it unchanged
 * so we never pretend the poison counter still signals listeners.
 */
export function nextIncomingVersion(current: unknown): number {
  if (typeof current === 'string') {
    // Historic bug: CF used `val + 1` which concatenates strings ("5"+1="51").
    const n = parseInt(current, 10);
    if (!Number.isFinite(n) || isUnsafeVersionNumber(n)) return Number.NaN;
    return n + 1;
  }
  const n = typeof current === 'number' ? current : parseInt(String(current ?? '0'), 10);
  if (!Number.isFinite(n)) return 0;
  if (isUnsafeVersionNumber(n)) return n;
  return n + 1;
}

/** Demonstrates the historic string-concat growth. */
export function unsafeStringIncrement(current: unknown): unknown {
  return (current as any || 0) + 1;
}

export function wellKeyOf(wellName: string): string {
  return String(wellName || '').replace(/\s+/g, '');
}

export function materializedPath(companyId: string, wellName: string): string {
  const company = String(companyId || '').replace(/[.#$\[\]/]/g, '_').slice(0, 80);
  const well = wellKeyOf(wellName).replace(/[.#$\[\]/]/g, '_').slice(0, 120);
  return `packets/materialized/${company}/${well}`;
}

export function buildMaterializedEvent(input: {
  kind: MaterializedKind;
  wellName: string;
  companyId: string;
  packetId?: string | null;
  atMs: number;
}): MaterializedEvent {
  const packetId = input.packetId ? String(input.packetId) : null;
  const eventId = `${input.kind}:${packetId || 'none'}:${input.atMs}`;
  return {
    eventId,
    packetId,
    wellName: input.wellName,
    companyId: input.companyId,
    kind: input.kind,
    atMs: input.atMs,
  };
}

export type ApplyDecision = 'apply' | 'wait' | 'ignore';

/**
 * Verify projections match the signal before display.
 * Pull: outgoing lastPullPacketId must equal event.packetId.
 * Edit: same packet id (identity preserved) — apply when lastPullPacketId matches.
 * Delete: outgoing must NOT still be the deleted packet id.
 */
export function decideApplyMaterialized(
  event: MaterializedEvent,
  outgoing: { lastPullPacketId?: string | null; wellName?: string } | null,
): ApplyDecision {
  if (!outgoing) return 'wait';
  const outId = outgoing.lastPullPacketId || null;
  if (event.kind === 'delete') {
    if (event.packetId && outId === event.packetId) return 'wait';
    return 'apply';
  }
  if (event.packetId && outId && outId !== event.packetId) return 'ignore';
  if (event.packetId && !outId) return 'wait';
  if (event.packetId && outId === event.packetId) return 'apply';
  return 'wait';
}

export function coalesceByWell(
  pending: Record<string, MaterializedEvent>,
  event: MaterializedEvent,
): Record<string, MaterializedEvent> {
  const key = `${event.companyId}:${wellKeyOf(event.wellName)}`;
  const prev = pending[key];
  if (!prev || event.atMs >= prev.atMs) {
    return { ...pending, [key]: event };
  }
  return pending;
}

export const FULL_PAGE_RELOAD_FORBIDDEN = 'window.location.reload';
