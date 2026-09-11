/**
 * Legacy idem_ vs canonical packet identity. Pure, tenant-contained.
 * New writes never use an idem_ key. Legacy records may prove a match.
 */
export function legacyIdemStorageKey(canonicalPacketId: string): string {
  const id = String(canonicalPacketId || '').trim();
  if (!id) return '';
  if (id.startsWith('idem_')) return id;
  return `idem_${id}`;
}

export function stripLegacyIdemPrefix(storageKey: string): string {
  const id = String(storageKey || '').trim();
  return id.startsWith('idem_') ? id.slice('idem_'.length) : id;
}

function normWell(v: unknown): string {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

export function pullIdentityFingerprint(rec: Record<string, unknown> | null | undefined): string {
  if (!rec || typeof rec !== 'object') return '';
  const well = normWell(rec.wellName);
  const dt = String(rec.dateTimeUTC || '').trim();
  const bbls = num(rec.bblsTaken);
  const feet = num(rec.tankLevelFeet);
  return `${well}|${dt}|${bbls ?? ''}|${feet ?? ''}`;
}

export function pullIdentitiesMatch(
  local: Record<string, unknown> | null | undefined,
  remote: Record<string, unknown> | null | undefined,
): boolean {
  const a = pullIdentityFingerprint(local);
  const b = pullIdentityFingerprint(remote);
  return !!a && a === b;
}

export type ProcessedPullLocation = 'exact' | 'legacy_idem';

export type ReconcilePullDecision =
  | { match: true; location: ProcessedPullLocation; canonicalPacketId: string }
  | { match: false; reason: 'not_found' | 'payload_mismatch' | 'cross_tenant' | 'invalid_id' };

export function decideProcessedPullReconcile(input: {
  canonicalPacketId: string;
  driverId: string;
  companyId: string;
  localIdentity: Record<string, unknown>;
  exact: Record<string, unknown> | null;
  legacyIdem: Record<string, unknown> | null;
}): ReconcilePullDecision {
  const canonical = String(input.canonicalPacketId || '').trim();
  if (!canonical || canonical.startsWith('idem_')) {
    return { match: false, reason: 'invalid_id' };
  }

  const consider = (
    rec: Record<string, unknown> | null,
    location: ProcessedPullLocation,
  ): ReconcilePullDecision | null => {
    if (!rec) return null;
    const recCompany = typeof rec.companyId === 'string' ? rec.companyId : '';
    const recDriver = typeof rec.driverId === 'string' ? rec.driverId : '';
    if (recCompany && recCompany !== input.companyId) {
      return { match: false, reason: 'cross_tenant' };
    }
    if (recDriver && recDriver !== input.driverId) {
      return { match: false, reason: 'cross_tenant' };
    }
    if (!pullIdentitiesMatch(input.localIdentity, rec)) {
      return { match: false, reason: 'payload_mismatch' };
    }
    return { match: true, location, canonicalPacketId: canonical };
  };

  const exact = consider(input.exact, 'exact');
  if (exact) return exact;
  const legacy = consider(input.legacyIdem, 'legacy_idem');
  if (legacy) return legacy;
  return { match: false, reason: 'not_found' };
}

/** Choose the processed parent for an edit: exact first, then legacy idem_. */
export function selectProcessedPullParent(input: {
  canonicalPacketId: string;
  driverId: string;
  companyId: string;
  exact: Record<string, unknown> | null;
  legacyIdem: Record<string, unknown> | null;
}): { record: Record<string, unknown>; location: ProcessedPullLocation } | { record: null; reason: string } {
  const canonical = String(input.canonicalPacketId || '').trim();
  if (!canonical || canonical.startsWith('idem_')) {
    return { record: null, reason: 'invalid_id' };
  }
  const pick = (
    rec: Record<string, unknown> | null,
    location: ProcessedPullLocation,
  ) => {
    if (!rec) return null;
    const recCompany = typeof rec.companyId === 'string' ? rec.companyId : '';
    const recDriver = typeof rec.driverId === 'string' ? rec.driverId : '';
    if (recCompany && recCompany !== input.companyId) return { blocked: 'cross_tenant' as const };
    if (recDriver && recDriver !== input.driverId) return { blocked: 'cross_tenant' as const };
    return { record: rec, location };
  };
  const exact = pick(input.exact, 'exact');
  if (exact && 'blocked' in exact) return { record: null, reason: exact.blocked };
  if (exact && 'record' in exact) return exact;
  const legacy = pick(input.legacyIdem, 'legacy_idem');
  if (legacy && 'blocked' in legacy) return { record: null, reason: legacy.blocked };
  if (legacy && 'record' in legacy) return legacy;
  return { record: null, reason: 'missing_original' };
}
