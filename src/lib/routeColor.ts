/**
 * Deterministic route colors using perceptually distinct hue anchors.
 * Human vision treats green (80-160°) as one color and is most sensitive to
 * red/blue/purple differences. This uses 12 anchor hues that LOOK different
 * to human eyes (not just numerically different), then assigns routes to
 * anchors with collision resolution.
 * Shared across WB M and Dashboard — must stay in sync.
 */

/** FNV-1a hash with avalanche finisher */
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

// 24 perceptually distinct colors — each one LOOKS different from its neighbors.
// Hand-tuned HSL values avoiding the "green blob" problem.
// Ordered so that linear probing always lands on a visually different color.
const COLORS = [
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

/**
 * Assign guaranteed-unique colors to a list of route names.
 * Hash picks the starting slot; linear probe resolves collisions.
 * Deterministic — same set of names always maps the same way.
 */
export function assignRouteColors(routeNames: string[]): Map<string, string> {
  const sorted = [...routeNames].sort();
  const colorMap = new Map<string, string>();
  const usedSlots = new Set<number>();

  for (const name of sorted) {
    if (name === 'Unrouted') {
      colorMap.set(name, '#888888');
      continue;
    }

    let slot = fnv1a(name) % COLORS.length;
    while (usedSlots.has(slot)) {
      slot = (slot + 1) % COLORS.length;
    }
    usedSlots.add(slot);
    colorMap.set(name, COLORS[slot]);
  }

  return colorMap;
}

/**
 * Standalone single-route color (no collision avoidance).
 * Use assignRouteColors() when the full route list is available.
 */
export function getRouteColor(routeName: string): string {
  if (routeName === 'Unrouted') return '#888888';
  return COLORS[fnv1a(routeName) % COLORS.length];
}
