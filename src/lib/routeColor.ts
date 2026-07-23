/**
 * CANONICAL route color resolver.
 *
 * CONTRACT: this file exists in BOTH repos and the two copies must stay
 * byte-identical (same palette, same hash, same salt, same normalization):
 *   wellbuilt-mobile:    src/services/routeColor.ts
 *   wellbuilt-dashboard: src/lib/routeColor.ts
 * Golden-fixture tests in each repo pin the exact same outputs.
 *
 * THE RULE (strict): a route's color is GENERATED from its normalized
 * route NAME — trim, collapse internal whitespace, lowercase — and from
 * nothing else. Colors are never admin-assigned, stored, index-assigned,
 * or overridden by any other identity. The same normalized name always
 * produces the same color on every device, driver assignment, sort
 * order, filter, and dashboard. Renaming a route may change its color —
 * that is expected. Blank names and 'Unrouted' are neutral gray.
 *
 * The orphaned per-well `well_config.color` strings in Firebase are
 * stale caches of a retired algorithm; they are ignored and untouched.
 *
 * The 24-color palette is hand-tuned for readable contrast on the dark
 * UI. HASH_SALT is part of the algorithm: 'wb2' was chosen so every
 * current production route lands on a distinct palette entry. Changing
 * the salt or palette recolors every route — never do it in one repo
 * without the other.
 */

export const UNROUTED_COLOR = '#888888';

export const ROUTE_PALETTE = [
  '#e04040', // red
  '#40b040', // green
  '#4080e0', // blue
  '#e0a020', // amber
  '#a040d0', // purple
  '#20c0c0', // cyan
  '#e06090', // rose
  '#80c020', // chartreuse
  '#6060e0', // indigo
  '#d07020', // burnt orange
  '#c040c0', // magenta
  '#20a080', // teal
  '#e0c040', // gold
  '#4060b0', // steel blue
  '#d06060', // salmon
  '#60c060', // lime
  '#8040a0', // plum
  '#40b0b0', // dark cyan
  '#c08040', // bronze
  '#9070d0', // soft violet
  '#60a040', // leaf
  '#b04080', // raspberry
  '#4090c0', // sky
  '#c0a060', // tan
];

const HASH_SALT = 'wb2:';

/** trim + collapse internal whitespace + lowercase — the canonical name key. */
export function normalizeRouteKey(name: unknown): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** FNV-1a with avalanche finisher — identical in both repos. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;
  h = ((h >> 16) ^ h) >>> 0;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h = ((h >> 16) ^ h) >>> 0;
  return h;
}

/**
 * The one canonical resolver: normalized route NAME in, color out.
 * No overrides of any kind. Deterministic, set-independent, identical
 * across WB-M and Dashboard.
 */
export function canonicalRouteColor(routeName: unknown): string {
  const key = normalizeRouteKey(routeName);
  if (!key || key === 'unrouted') return UNROUTED_COLOR;
  return ROUTE_PALETTE[fnv1a(HASH_SALT + key) % ROUTE_PALETTE.length];
}

/** Back-compat call-site signature — every screen resolves through here. */
export function getRouteColor(routeName: string): string {
  return canonicalRouteColor(routeName);
}
