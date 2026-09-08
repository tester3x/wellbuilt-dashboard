/**
 * Dashboard WB-M realtime merge — no full-page reload, no session reset.
 * Native WB-M canonical listener is packets/outgoing (company-scoped child
 * events). This module is the Dashboard equivalent plus ownership checks.
 */

export interface MaterializedEvent {
  opId: string;
  eventId: string;
  packetId: string | null;
  survivorPacketId?: string | null;
  wellName: string;
  companyId: string;
  kind: 'pull' | 'edit' | 'delete' | 'status';
  atMs: number;
  resultAtMs?: number;
}

export const FULL_PAGE_RELOAD_SNIPPET = 'window.location.reload';

export function wellKeyOf(wellName: string): string {
  return String(wellName || '').replace(/\s+/g, '');
}

export interface OutgoingSlice {
  wellName: string;
  lastPullPacketId?: string | null;
  currentLevel?: string;
  companyId?: string;
}

export function decideApplyMaterialized(
  event: MaterializedEvent,
  outgoing: { lastPullPacketId?: string | null } | null,
): 'apply' | 'wait' | 'ignore' {
  if (!outgoing) return 'wait';
  const outId = outgoing.lastPullPacketId || null;
  if (event.kind === 'delete') {
    if (event.packetId && outId === event.packetId) return 'wait';
    if (event.survivorPacketId && outId && outId !== event.survivorPacketId) return 'wait';
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
  if (!prev) return { ...pending, [key]: event };
  const incomingAt = event.resultAtMs ?? event.atMs;
  const prevAt = prev.resultAtMs ?? prev.atMs;
  if (incomingAt >= prevAt) return { ...pending, [key]: event };
  return pending;
}

export function indexOutgoingByWell(
  children: Array<{ key: string; val: Record<string, unknown> }>,
): Record<string, OutgoingSlice & Record<string, unknown>> {
  const out: Record<string, OutgoingSlice & Record<string, unknown>> = {};
  for (const child of children) {
    if (!child.key.startsWith('response_') || child.key.includes('delete')) continue;
    const wellName = typeof child.val.wellName === 'string' ? child.val.wellName : '';
    if (!wellName) continue;
    out[wellKeyOf(wellName)] = {
      ...child.val,
      wellName,
      lastPullPacketId: (child.val.lastPullPacketId as string) || null,
      responseId: child.key,
    };
  }
  return out;
}

export function filterOutgoingByCompany(
  indexed: Record<string, OutgoingSlice & Record<string, unknown>>,
  companyId: string | null | undefined,
): Record<string, OutgoingSlice & Record<string, unknown>> {
  if (!companyId) return indexed;
  const out: typeof indexed = {};
  for (const [k, v] of Object.entries(indexed)) {
    const cid = v.companyId;
    if (cid === companyId || cid == null || cid === '') out[k] = v;
  }
  return out;
}

export function applyMaterializedWithRetry(
  event: MaterializedEvent,
  outgoing: OutgoingSlice | null,
  attempt: number,
  maxAttempts = 4,
): { decision: 'apply' | 'wait' | 'ignore'; nextAttempt: number } {
  const decision = decideApplyMaterialized(event, outgoing);
  if (decision === 'wait' && attempt + 1 < maxAttempts) {
    return { decision, nextAttempt: attempt + 1 };
  }
  return { decision: decision === 'wait' ? 'ignore' : decision, nextAttempt: attempt };
}

export interface WellUiSession {
  expandedRoutes: string[];
  wellSearch: string;
  viewMode: string;
  demoPresenceActive?: boolean;
  scrollTop?: number;
  selectedTab?: string;
}

export function preserveUiSession(prev: WellUiSession): WellUiSession {
  return {
    expandedRoutes: [...prev.expandedRoutes],
    wellSearch: prev.wellSearch,
    viewMode: prev.viewMode,
    demoPresenceActive: prev.demoPresenceActive,
    scrollTop: prev.scrollTop,
    selectedTab: prev.selectedTab,
  };
}

export function wellChangeIsolated(
  before: Record<string, { currentLevel?: string }>,
  after: Record<string, { currentLevel?: string }>,
  changedKey: string,
): boolean {
  for (const key of Object.keys(before)) {
    if (key === changedKey) continue;
    if (before[key]?.currentLevel !== after[key]?.currentLevel) return false;
  }
  return true;
}
