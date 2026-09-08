/**
 * Collision-safe well materialization signal.
 *
 * Do NOT reset packets/incoming_version. Dual-write per company/well:
 *   packets/materialized/{companyId}/{wellKey}
 *
 * Operation identity is stable (not wall-clock):
 *   pull:   pull:{packetId}
 *   edit:   edit:{editRequestId}:{targetPacketId}
 *   delete: delete:{deleteRequestId}:{targetPacketId}:{survivorPacketId|none}
 * atMs / resultAtMs are metadata. CAS rejects an older retry.
 */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export type MaterializedKind = 'pull' | 'edit' | 'delete' | 'status';

export interface MaterializedEvent {
  opId: string;
  eventId: string;
  packetId: string | null;
  targetPacketId: string | null;
  survivorPacketId: string | null;
  wellName: string;
  companyId: string;
  kind: MaterializedKind;
  atMs: number;
  resultAtMs: number;
}

export function isUnsafeVersionNumber(current: unknown): boolean {
  const n = typeof current === 'number' ? current : Number(current);
  if (!Number.isFinite(n)) return true;
  return n > MAX_SAFE || n + 1 === n;
}

export function nextIncomingVersion(current: unknown): number {
  if (typeof current === 'string') {
    const asNum = Number(current);
    if (Number.isFinite(asNum) && isUnsafeVersionNumber(asNum)) return asNum;
    const n = parseInt(current, 10);
    if (!Number.isFinite(n) || isUnsafeVersionNumber(n)) {
      return Number.isFinite(asNum) ? asNum : 0;
    }
    return n + 1;
  }
  const n = typeof current === 'number' ? current : parseInt(String(current ?? '0'), 10);
  if (!Number.isFinite(n)) return 0;
  if (isUnsafeVersionNumber(n)) return n;
  return n + 1;
}

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

export function pullOpId(packetId: string): string {
  return `pull:${packetId}`;
}

export function editOpId(editRequestId: string, targetPacketId: string): string {
  return `edit:${editRequestId}:${targetPacketId}`;
}

export function deleteOpId(
  deleteRequestId: string,
  targetPacketId: string,
  survivorPacketId: string | null,
): string {
  return `delete:${deleteRequestId}:${targetPacketId}:${survivorPacketId || 'none'}`;
}

export function buildMaterializedEvent(input: {
  kind: MaterializedKind;
  wellName: string;
  companyId: string;
  opId: string;
  packetId?: string | null;
  targetPacketId?: string | null;
  survivorPacketId?: string | null;
  atMs: number;
  resultAtMs: number;
}): MaterializedEvent {
  const packetId = input.packetId ? String(input.packetId) : null;
  return {
    opId: input.opId,
    eventId: input.opId,
    packetId,
    targetPacketId: input.targetPacketId ? String(input.targetPacketId) : packetId,
    survivorPacketId: input.survivorPacketId ? String(input.survivorPacketId) : null,
    wellName: input.wellName,
    companyId: input.companyId,
    kind: input.kind,
    atMs: input.atMs,
    resultAtMs: input.resultAtMs,
  };
}

export type CasDecision = 'write' | 'idempotent' | 'reject_stale';

export function decideMaterializedCas(
  existing: MaterializedEvent | null,
  incoming: MaterializedEvent,
): CasDecision {
  if (!existing) return 'write';
  if (existing.opId === incoming.opId) return 'idempotent';
  if (incoming.resultAtMs < existing.resultAtMs) return 'reject_stale';
  if (incoming.resultAtMs === existing.resultAtMs && incoming.opId < existing.opId) {
    return 'reject_stale';
  }
  return 'write';
}

/** Transaction updater: abort (undefined) keeps existing. */
export function materializedCasUpdater(incoming: MaterializedEvent) {
  return (current: unknown): MaterializedEvent | undefined => {
    const existing =
      current && typeof current === 'object' ? (current as MaterializedEvent) : null;
    const d = decideMaterializedCas(existing, incoming);
    if (d === 'write') return incoming;
    return undefined;
  };
}

export type ApplyDecision = 'apply' | 'wait' | 'ignore';

export function decideApplyMaterialized(
  event: MaterializedEvent,
  outgoing: { lastPullPacketId?: string | null; wellName?: string } | null,
): ApplyDecision {
  if (!outgoing) return 'wait';
  const outId = outgoing.lastPullPacketId || null;
  if (event.kind === 'delete') {
    const survivor = event.survivorPacketId;
    if (event.packetId && outId === event.packetId) return 'wait';
    if (survivor && outId && outId !== survivor) return 'wait';
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
  if (!prev || event.resultAtMs >= prev.resultAtMs) {
    return { ...pending, [key]: event };
  }
  return pending;
}
