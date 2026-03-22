/**
 * Deterministic route color from route name.
 * Uses djb2 hash → HSL → RGB. Same name always produces same color.
 * Shared across WB M and Dashboard — must stay in sync.
 */
export function getRouteColor(routeName: string): string {
  let hash = 5381;
  for (let i = 0; i < routeName.length; i++) {
    hash = ((hash << 5) + hash) + routeName.charCodeAt(i);
    hash = hash & hash;
  }
  hash = Math.abs(hash);
  const hue = hash % 360;
  const sat = 0.65;
  const lum = 0.55;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lum - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  switch (Math.floor(hue / 60)) {
    case 0: r1 = c; g1 = x; break;
    case 1: r1 = x; g1 = c; break;
    case 2: g1 = c; b1 = x; break;
    case 3: g1 = x; b1 = c; break;
    case 4: r1 = x; b1 = c; break;
    default: r1 = c; b1 = x; break;
  }
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
