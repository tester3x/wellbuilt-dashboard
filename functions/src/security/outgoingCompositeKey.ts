/**
 * Deterministic, Firebase-safe composite storage identity for packets/outgoing.
 * Based on (companyId, wellId).
 *
 * Keys start with 'response_' to maintain compatibility with existing consumers
 * that filter on key.startsWith('response_').
 */

export function rtdbSafeSegment(segment: string): string {
  return String(segment || '')
    .trim()
    .replace(/[.#$\[\]/]/g, '_');
}

/**
 * Builds the deterministic composite key for a well's status under packets/outgoing.
 * Format: response_${safeCompanyId}__${safeWellId}
 */
export function outgoingCompositeKey(companyId: string, wellId: string): string {
  const safeCompany = rtdbSafeSegment(companyId);
  const safeWell = rtdbSafeSegment(wellId);
  if (!safeCompany || !safeWell) {
    throw new Error(`Invalid composite key inputs: companyId="${companyId}", wellId="${wellId}"`);
  }
  return `response_${safeCompany}__${safeWell}`;
}

/**
 * Parses a composite key into companyId and wellId if it matches the format.
 */
export function parseOutgoingCompositeKey(key: string): { companyId: string; wellId: string } | null {
  if (typeof key !== 'string' || !key.startsWith('response_')) return null;
  const body = key.slice('response_'.length);
  const delimIdx = body.indexOf('__');
  if (delimIdx <= 0) return null;
  const companyId = body.slice(0, delimIdx);
  const wellId = body.slice(delimIdx + 2);
  if (!companyId || !wellId) return null;
  return { companyId, wellId };
}
