/**
 * Phase 25 — demo → account bridge payload encoder/decoder.
 *
 * The public /demo page collects a company name + a few location names
 * with zero Firebase writes. Phase 25 bridges that intent into the
 * registration flow: when the user taps "Create an account", we carry
 * the demo setup forward via URL query params and sessionStorage so the
 * signed-in onboarding flow (future phase) can pick up right where the
 * demo left off.
 *
 * Invariants:
 *   - pure helpers, no React, no Firebase, no admin callables
 *   - bounded: company name ≤ 200 chars, max 10 locations ≤ 200 chars each
 *   - safe: decode returns null on any parse / shape error (no throws)
 *   - back-compat: missing or malformed `demo` param → null, caller
 *     renders the registration page exactly as before
 */

export const DEMO_BRIDGE_PARAM = 'demo';
export const DEMO_BRIDGE_STORAGE_KEY = 'wb:demoSetup';

const MAX_LOCATIONS = 10;
const MAX_NAME_LEN = 200;

export interface DemoBridgePayload {
  company: string;
  locations: string[];
}

function sanitize(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_NAME_LEN);
}

function sanitizeLocations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = sanitize(entry);
    if (s.length === 0) continue;
    out.push(s);
    if (out.length >= MAX_LOCATIONS) break;
  }
  return out;
}

/**
 * Encode a demo payload into a single URL-safe query-string value.
 * Uses JSON + encodeURIComponent so the payload survives any reserved
 * character in the company name or location names.
 *
 * Returns an empty string if the payload is effectively empty — the
 * caller should not add a `demo=` param at all in that case.
 */
export function encodeDemoBridgeQuery(
  payload: DemoBridgePayload
): string {
  const clean: DemoBridgePayload = {
    company: sanitize(payload.company),
    locations: sanitizeLocations(payload.locations),
  };
  if (clean.company.length === 0 && clean.locations.length === 0) {
    return '';
  }
  try {
    return encodeURIComponent(JSON.stringify(clean));
  } catch {
    // JSON.stringify shouldn't throw on these primitives, but the
    // catch keeps the bridge safe under any future type drift.
    return '';
  }
}

/**
 * Build a full query string like `?demo=1&payload=<encoded>`. Returns
 * an empty string if the payload is effectively empty (no demo hint).
 * Caller can concatenate directly onto a bare path.
 */
export function buildDemoBridgeQueryString(
  payload: DemoBridgePayload
): string {
  const encoded = encodeDemoBridgeQuery(payload);
  if (encoded.length === 0) return '';
  return `?${DEMO_BRIDGE_PARAM}=1&payload=${encoded}`;
}

/**
 * Decode a URL-safe demo payload back into structured data. Returns
 * null on any failure — no throws. Callers render the page normally
 * when null comes back.
 *
 * Accepts either a URLSearchParams instance or a plain record of
 * strings, so it works against both browser `useSearchParams()` and
 * test harnesses.
 */
export function decodeDemoBridgeQuery(
  source:
    | URLSearchParams
    | Record<string, string | null | undefined>
    | null
    | undefined
): DemoBridgePayload | null {
  if (!source) return null;
  const get = (k: string): string | null => {
    if (source instanceof URLSearchParams) return source.get(k);
    const v = (source as Record<string, string | null | undefined>)[k];
    return typeof v === 'string' ? v : null;
  };
  const demoFlag = get(DEMO_BRIDGE_PARAM);
  if (demoFlag !== '1') return null;
  const raw = get('payload');
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const json = decodeURIComponent(raw);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { company?: unknown; locations?: unknown };
    const company = sanitize(obj.company);
    const locations = sanitizeLocations(obj.locations);
    if (company.length === 0 && locations.length === 0) return null;
    return { company, locations };
  } catch {
    return null;
  }
}
