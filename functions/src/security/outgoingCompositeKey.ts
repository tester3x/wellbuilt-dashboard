/**
 * Deterministic, Firebase-safe composite storage identity for packets/outgoing.
 * Based on (companyId, wellId).
 *
 * Keys start with 'response_' to maintain compatibility with existing consumers
 * that filter on key.startsWith('response_').
 */

/**
 * Injective, collision-resistant, reversible RTDB-safe segment encoding.
 * 
 * Rules:
 * - Preserves standard alphanumeric and hyphen characters: [a-zA-Z0-9-]
 * - Escapes every other UTF-8 byte as '~' + 2-digit lowercase hex (e.g. '_' -> '~5f', '.' -> '~2e', '/' -> '~2f')
 * - Because '_' is always escaped as '~5f', the delimiter '__' NEVER appears within an encoded segment.
 * - Injective and strictly collision-resistant for all strings, Unicode, and RTDB-forbidden characters.
 * - Maximum supported raw segment length: 128 characters (well within RTDB 768-byte key limit).
 */
export function encodeSegment(segment: string): string {
  if (typeof segment !== 'string' || !segment.trim()) {
    throw new Error('Segment must be a non-empty string');
  }
  const str = segment.trim();
  if (str.length > 128) {
    throw new Error(`Segment exceeds maximum supported length of 128 characters: "${str.slice(0, 32)}..."`);
  }
  const buf = Buffer.from(str, 'utf8');
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // Allow ASCII letters (A-Z: 65-90, a-z: 97-122), digits (0-9: 48-57), and hyphen (-: 45)
    if (
      (b >= 48 && b <= 57) ||
      (b >= 65 && b <= 90) ||
      (b >= 97 && b <= 122) ||
      b === 45
    ) {
      out += String.fromCharCode(b);
    } else {
      out += '~' + b.toString(16).padStart(2, '0');
    }
  }
  return out;
}

/**
 * Reversibly decodes an encoded segment back to its original UTF-8 string.
 */
export function decodeSegment(encoded: string): string {
  if (typeof encoded !== 'string') return '';
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '~') {
      const hex = encoded.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(encoded.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Backward compatibility alias pointing to injective encoder */
export const rtdbSafeSegment = encodeSegment;

/**
 * Builds the deterministic, collision-resistant composite key for a well's status under packets/outgoing.
 * Format: response_${encodeSegment(companyId)}__${encodeSegment(wellId)}
 */
export function outgoingCompositeKey(companyId: string, wellId: string): string {
  const safeCompany = encodeSegment(companyId);
  const safeWell = encodeSegment(wellId);
  return `response_${safeCompany}__${safeWell}`;
}

/**
 * Parses and reversibly decodes a composite key into exact original companyId and wellId.
 */
export function parseOutgoingCompositeKey(key: string): { companyId: string; wellId: string } | null {
  if (typeof key !== 'string' || !key.startsWith('response_')) return null;
  const body = key.slice('response_'.length);
  const delimIdx = body.indexOf('__');
  if (delimIdx <= 0) return null;
  const rawCompany = body.slice(0, delimIdx);
  const rawWell = body.slice(delimIdx + 2);
  if (!rawCompany || !rawWell) return null;
  try {
    const companyId = decodeSegment(rawCompany);
    const wellId = decodeSegment(rawWell);
    if (!companyId || !wellId) return null;
    return { companyId, wellId };
  } catch {
    return null;
  }
}
