/**
 * Pure selection of packets/outgoing for an authenticated WB-M driver.
 * Legacy rows often have no companyId — never require it. Filter only by
 * server-resolved authorized well names.
 */
export type OutgoingStatusRecord = Record<string, unknown> & { wellName: string };

export function packetTimestampMs(row: Record<string, unknown>): number {
  const raw = row.timestampUTC || row.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function collectLatestOutgoingByWell(outgoingTree: unknown): Map<string, OutgoingStatusRecord> {
  const latest = new Map<string, OutgoingStatusRecord>();
  if (!outgoingTree || typeof outgoingTree !== 'object' || Array.isArray(outgoingTree)) {
    return latest;
  }
  for (const [key, raw] of Object.entries(outgoingTree as Record<string, unknown>)) {
    if (!key.startsWith('response_')) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const wellName = typeof row.wellName === 'string' ? row.wellName.trim() : '';
    if (!wellName) continue;
    const prev = latest.get(wellName);
    if (!prev || packetTimestampMs(row) >= packetTimestampMs(prev)) {
      latest.set(wellName, { ...row, wellName });
    }
  }
  return latest;
}

export function partitionAuthorizedOutgoing(input: {
  latestByWell: Map<string, OutgoingStatusRecord>;
  authorizedWells: string[];
}): { responses: OutgoingStatusRecord[]; unavailableWells: string[] } {
  const allowed = new Set(input.authorizedWells.filter((n) => typeof n === 'string' && n.trim()));
  const responses: OutgoingStatusRecord[] = [];
  const unavailableWells: string[] = [];
  for (const wellName of allowed) {
    const row = input.latestByWell.get(wellName);
    if (row) responses.push(row);
    else unavailableWells.push(wellName);
  }
  return { responses, unavailableWells };
}

export function companyIdForOutgoingWell(wellConfigRow: unknown): string {
  if (wellConfigRow && typeof wellConfigRow === 'object' && !Array.isArray(wellConfigRow)) {
    const cid = (wellConfigRow as Record<string, unknown>).companyId;
    if (typeof cid === 'string' && cid.trim()) return cid.trim();
  }
  return 'liquid-gold';
}
