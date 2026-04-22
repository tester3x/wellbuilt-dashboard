/**
 * Phase 18 — shared normalization for exact-match comparisons against the
 * official-location reference (SWD / disposal, and future NDIC additions).
 *
 * Rules (spec §Normalization):
 *   - lowercase
 *   - trim outer whitespace
 *   - replace each of `-`, `_`, `.`, `,` with a single space
 *   - collapse runs of internal whitespace to one space
 *   - re-trim (in case punctuation replacement left edge whitespace)
 *
 * Numbers and non-punctuation characters are preserved so `ATLAS-1` and
 * `ATLAS 1` both normalize to `"atlas 1"` while `ATLAS 1` and `ATLAS 2`
 * stay distinct.
 *
 * This is intentionally more aggressive than the existing
 * `normalizeLocationName` (in normalizeLocation.ts) — that helper only
 * lowercases / trims / unifies whitespace and is used for NDIC /
 * well_config exact matches where preserving punctuation is important.
 * Phase 18's reference is about driver-entered names that commonly drop
 * punctuation vs. an official canonical form, so more aggressive folding
 * is appropriate here.
 */
export function normalizeLocationNameForOfficialMatch(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[-_.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
