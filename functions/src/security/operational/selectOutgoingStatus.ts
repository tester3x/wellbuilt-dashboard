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

export function collectLatestOutgoingByWell(
  outgoingTree: unknown,
  driverCompanyId?: string,
): Map<string, OutgoingStatusRecord> {
  const latest = new Map<string, OutgoingStatusRecord>();
  if (!outgoingTree || typeof outgoingTree !== 'object' || Array.isArray(outgoingTree)) {
    return latest;
  }
  const targetCompany = typeof driverCompanyId === 'string' ? driverCompanyId.trim() : '';
  const ambiguousNames = new Set<string>();
  const seenIdentities = new Map<string, string>(); // wellName -> identity key

  for (const [key, raw] of Object.entries(outgoingTree as Record<string, unknown>)) {
    if (!key.startsWith('response_')) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const wellName = typeof row.wellName === 'string' ? row.wellName.trim() : '';
    if (!wellName) continue;

    const rowCompany = typeof row.companyId === 'string' ? row.companyId.trim() : '';
    const rowWellId = typeof row.wellId === 'string' ? row.wellId.trim() : '';

    // When company scoping is active, require matching companyId and canonical wellId
    if (targetCompany) {
      if (!rowCompany || rowCompany !== targetCompany || !rowWellId) {
        // Missing canonical identity or foreign company: must never be cross-attached
        continue;
      }
    } else {
      // Unscoped mode: track identity collision across tenants / wells for the same wellName
      const identityKey = `${rowCompany || 'anon'}__${rowWellId || 'anon'}`;
      const prevIdentity = seenIdentities.get(wellName);
      if (prevIdentity && prevIdentity !== identityKey) {
        ambiguousNames.add(wellName);
      } else {
        seenIdentities.set(wellName, identityKey);
      }
    }

    const prev = latest.get(wellName);
    if (!prev || packetTimestampMs(row) >= packetTimestampMs(prev)) {
      latest.set(wellName, { ...row, wellName });
    }
  }

  // In unscoped mode, duplicate / conflicting names across identities must remain unavailable
  if (!targetCompany && ambiguousNames.size > 0) {
    for (const ambig of ambiguousNames) {
      latest.delete(ambig);
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
