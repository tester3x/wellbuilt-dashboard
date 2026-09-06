/**
 * Static-export-safe spill detail URLs.
 * Canonical: /safety/spills/detail?incidentId=<id>&companyId=<optional>
 * Incident IDs match WB-T spillBackendCore SPILL_ID_RE.
 */

export const SPILL_DETAIL_PATH = '/safety/spills/detail';
export const SPILL_ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;
export const SPILL_DETAIL_MISSING_COPY = 'Missing incident ID.';
export const SPILL_DETAIL_MALFORMED_COPY = 'Invalid incident ID.';
export const SPILL_DETAIL_NOT_FOUND_COPY = 'Incident not found.';

export type SpillDetailIdParse =
  | { ok: true; incidentId: string }
  | { ok: false; reason: 'missing' | 'malformed' };

export function buildSpillDetailHref(incidentId: string, companyId?: string | null): string {
  const params = new URLSearchParams();
  params.set('incidentId', String(incidentId || '').trim());
  const cid = String(companyId || '').trim();
  if (cid) params.set('companyId', cid);
  return `${SPILL_DETAIL_PATH}?${params.toString()}`;
}

export function extractLegacyPathIncidentId(pathname?: string | null): string | null {
  if (!pathname) return null;
  const p = String(pathname).split('?')[0].replace(/\/+$/, '');
  const m = p.match(/^\/safety\/spills\/([^/]+)$/);
  if (!m) return null;
  if (m[1] === 'detail') return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export function validateSpillIncidentIdParam(raw: string | null | undefined): SpillDetailIdParse {
  if (raw == null) return { ok: false, reason: 'missing' };
  let decoded = String(raw);
  try {
    if (/%[0-9A-Fa-f]{2}/.test(decoded)) decoded = decodeURIComponent(decoded);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const id = decoded.trim();
  if (!id) return { ok: false, reason: 'missing' };
  if (!SPILL_ID_RE.test(id)) return { ok: false, reason: 'malformed' };
  return { ok: true, incidentId: id };
}

export function parseSpillDetailIncidentId(input: {
  searchIncidentId?: string | null;
  pathname?: string | null;
}): SpillDetailIdParse {
  const fromQuery = input.searchIncidentId != null && String(input.searchIncidentId).length > 0
    ? String(input.searchIncidentId)
    : '';
  const raw = fromQuery || extractLegacyPathIncidentId(input.pathname) || '';
  if (!raw) return { ok: false, reason: 'missing' };
  return validateSpillIncidentIdParam(raw);
}

export function spillDetailRouteErrorCopy(reason: 'missing' | 'malformed'): string {
  return reason === 'missing' ? SPILL_DETAIL_MISSING_COPY : SPILL_DETAIL_MALFORMED_COPY;
}
