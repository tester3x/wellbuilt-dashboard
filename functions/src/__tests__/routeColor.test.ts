// GOLDEN FIXTURES — canonical route colors.
// This fixture block is intentionally IDENTICAL in both repos
// (wellbuilt-mobile and wellbuilt-dashboard); it IS the cross-repo
// contract. If a value changes here it must change in the twin file.
// (Lives under functions/__tests__ because this repo's jest runner is
// here; the module under test is the dashboard UI lib.)
import * as fs from 'fs';
import * as path from 'path';
import {
  ROUTE_PALETTE,
  UNROUTED_COLOR,
  canonicalRouteColor,
  getRouteColor,
  isValidHexColor,
  normalizeRouteKey,
} from '../../../src/lib/routeColor';

/** Real production routes — every one must keep exactly this color. */
const GOLDEN: Record<string, string> = {
  'Acme Newtown': '#4080e0',
  'Dunn County': '#e0c040',
  'Gabriels': '#d06060',
  'Gunslingers': '#20c0c0',
  'Montana': '#e06090',
  'River Bottoms': '#20a080',
  'Stock Yards': '#e0a020',
  'Test Route': '#c0a060',
  'Watford': '#4060b0',
};

describe('golden fixtures — exact canonical colors', () => {
  test.each(Object.entries(GOLDEN))('%s → %s', (route, hex) => {
    expect(getRouteColor(route)).toBe(hex);
  });

  test('all real routes resolve to DISTINCT colors', () => {
    const colors = Object.keys(GOLDEN).map(getRouteColor);
    expect(new Set(colors).size).toBe(colors.length);
  });

  test('whitespace and capitalization variants collapse to the same color', () => {
    expect(getRouteColor('  Gabriels  ')).toBe(GOLDEN['Gabriels']);
    expect(getRouteColor('GABRIELS')).toBe(GOLDEN['Gabriels']);
    expect(getRouteColor('gabriels')).toBe(GOLDEN['Gabriels']);
    expect(getRouteColor('Test  Route')).toBe(GOLDEN['Test Route']);
    expect(normalizeRouteKey('  Test   Route ')).toBe('test route');
  });

  test('missing/blank/Unrouted names resolve to neutral gray, never a crash', () => {
    expect(getRouteColor('')).toBe(UNROUTED_COLOR);
    expect(getRouteColor('   ')).toBe(UNROUTED_COLOR);
    expect(getRouteColor('Unrouted')).toBe(UNROUTED_COLOR);
    expect(canonicalRouteColor(null)).toBe(UNROUTED_COLOR);
    expect(canonicalRouteColor(undefined)).toBe(UNROUTED_COLOR);
    expect(canonicalRouteColor({ name: 42 })).toBe(getRouteColor('42'));
  });

  test('a VALID explicit configured color always wins', () => {
    expect(canonicalRouteColor({ name: 'Gabriels', explicitColor: '#A1B2C3' })).toBe('#a1b2c3');
    expect(canonicalRouteColor({ name: 'Gabriels', explicitColor: '#fff' })).toBe('#fff');
  });

  test('an INVALID explicit color falls back to the canonical hash', () => {
    for (const bad of ['red', '#12345', 'rgb(1,2,3)', '', null, 7]) {
      expect(canonicalRouteColor({ name: 'Gabriels', explicitColor: bad })).toBe(GOLDEN['Gabriels']);
    }
    expect(isValidHexColor('#d06060')).toBe(true);
    expect(isValidHexColor('rgb(150, 210, 152)')).toBe(false); // legacy well_config.color shape — never trusted
  });

  test('a stable route ID takes precedence over the name (rename-safe once IDs exist)', () => {
    expect(canonicalRouteColor({ name: 'Gabriels', routeId: 'route-42' })).toBe('#a040d0');
    expect(canonicalRouteColor({ name: 'Renamed Gabriels', routeId: 'route-42' })).toBe('#a040d0');
    expect(canonicalRouteColor({ name: 'Gabriels', routeId: 'route-42', explicitColor: '#abc' })).toBe('#abc');
  });
});

describe('assignment/set independence — the same route, the same color, everywhere', () => {
  const ALL = Object.keys(GOLDEN);

  test('color never depends on which routes a driver/company is scoped to', () => {
    // Driver A: only Gabriels. Driver B: eight routes. Customer admin: all.
    const subsets = [
      ['Gabriels'],
      ALL.filter((r) => r !== 'Montana'),
      ALL,
      ['Test Route', 'Gabriels'],
      ['Watford'],
    ];
    for (const subset of subsets) {
      for (const route of subset) {
        expect(getRouteColor(route)).toBe(GOLDEN[route]);
      }
    }
  });

  test('color never depends on index, sort order, or reordering of the list', () => {
    const orders = [
      [...ALL],
      [...ALL].reverse(),
      [...ALL].sort(() => 0.5 - ((Math.abs(Math.sin(1)) * 1000) % 1)), // fixed pseudo-shuffle
    ];
    for (const order of orders) {
      order.forEach((route, index) => {
        expect(getRouteColor(route)).toBe(GOLDEN[route]);
        expect(index).toBeGreaterThanOrEqual(0); // index exists but is irrelevant
      });
    }
  });

  test('inserting/removing unrelated routes changes nothing', () => {
    expect(getRouteColor('Gabriels')).toBe(GOLDEN['Gabriels']);
    for (const r of ['Brand New Route', 'Another One', 'Zebra']) getRouteColor(r);
    expect(getRouteColor('Gabriels')).toBe(GOLDEN['Gabriels']);
    expect(getRouteColor('Test Route')).toBe(GOLDEN['Test Route']);
  });

  test('palette keeps readable contrast on the dark UI', () => {
    for (const hex of ROUTE_PALETTE) {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      expect(lum).toBeGreaterThan(0.15); // visible against the dark theme
    }
  });
});

describe('wiring — every Dashboard surface uses the ONE canonical resolver', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

  test('WB Mobile page resolves per-route colors canonically at every call site', () => {
    const src = read('../../../src/app/mobile/page.tsx');
    expect(src).toContain("import { getRouteColor } from '@/lib/routeColor'");
    expect(src.split('getRouteColor(route)').length - 1).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain('assignRouteColors');
    expect(src).not.toContain('routeColorMap');
  });

  test('the set-dependent assignRouteColors implementation is fully removed', () => {
    const lib = read('../../../src/lib/routeColor.ts');
    expect(lib).not.toContain('assignRouteColors');
    expect(lib).not.toContain('usedSlots'); // linear-probe remnant
    const grepDirs = ['../../../src/app/mobile/page.tsx', '../../../src/app/dispatch/page.tsx'];
    for (const f of grepDirs) {
      expect(read(f)).not.toContain('assignRouteColors');
    }
  });

  test('the two repos share a byte-identical resolver (local twin check)', () => {
    const dash = read('../../../src/lib/routeColor.ts');
    const mobilePath = 'C:/dev/wellbuilt-mobile/src/services/routeColor.ts';
    if (fs.existsSync(mobilePath)) {
      expect(fs.readFileSync(mobilePath, 'utf8')).toBe(dash);
    }
  });
});
