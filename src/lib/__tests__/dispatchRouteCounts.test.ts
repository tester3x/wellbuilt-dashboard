import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWell, wellBucket, type QueueView } from '../dispatchPriority.ts';
import type { WellResponse } from '../wellPoolCore.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Helper function modeling the route-scoped count derivation used in Dispatch
function computeRouteViewCounts(
  wells: WellResponse[],
  routeFilter: string,
  asOfMs: number,
  activeAssignments: Map<string, { status: string }> = new Map(),
) {
  const routeWells = !routeFilter || routeFilter === 'all'
    ? wells
    : wells.filter((w) => w.route === routeFilter);

  let unassignedNeedsPull = 0;
  let assignedNeedsPull = 0;

  for (const w of routeWells) {
    if (w.isDown || w.currentLevel === 'DOWN') continue; // DOWN out of Needs Pull prediction
    const a = activeAssignments.get(w.wellName);
    if (a && a.status === 'in_progress') continue; // started excluded
    if (classifyWell(w, asOfMs).state !== 'pull-now') continue;
    if (a && a.status === 'pending') assignedNeedsPull++;
    else unassignedNeedsPull++;
  }

  const needsPullTotal = unassignedNeedsPull + assignedNeedsPull;

  // ALL counts every route well INCLUDING DOWN (they appear in the ALL view, badged
  // DOWN). next-24h / needs-data derive from wellBucket, which sorts DOWN into its own
  // 'down' bucket, so those predictive counts naturally exclude DOWN.
  return {
    'needs-pull': needsPullTotal,
    'next-24h': routeWells.filter((w) => wellBucket(w, asOfMs) === 'next-24h').length,
    'needs-data': routeWells.filter((w) => wellBucket(w, asOfMs) === 'needs-data').length,
    'all': routeWells.length,
  } as Record<QueueView, number>;
}

const baseTime = '2026-09-15T12:00:00Z';
const mockWells: WellResponse[] = [
  // Gabriels route (5 wells)
  {
    wellName: 'Gabriel 2',
    route: 'Gabriels',
    currentLevel: '14\'0"',
    lastPullBottomLevel: '14\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '1:00:00',
    etaToMax: '',
    timestamp: '',
  },
  {
    wellName: 'Gabriel 3',
    route: 'Gabriels',
    currentLevel: '12\'0"',
    lastPullBottomLevel: '12\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '1:00:00',
    etaToMax: '',
    timestamp: '',
  },
  {
    wellName: 'Gabriel 5',
    route: 'Gabriels',
    currentLevel: '16\'0"',
    lastPullBottomLevel: '16\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '0:30:00',
    etaToMax: '',
    timestamp: '',
  },
  {
    wellName: 'Gabriel 6',
    route: 'Gabriels',
    currentLevel: '8\'0"',
    lastPullBottomLevel: '8\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '2:00:00',
    etaToMax: '',
    timestamp: '',
  },
  {
    wellName: 'Gabriel 7',
    route: 'Gabriels',
    currentLevel: '--',
    lastPullBottomLevel: undefined,
    lastPullDateTimeUTC: undefined,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: 'Unknown',
    timestampUTC: '',
    etaToMax: '',
    timestamp: '',
  },

  // Stock Yards route (3 wells)
  {
    wellName: 'Stock Yards 1',
    route: 'Stock Yards',
    currentLevel: '15\'0"',
    lastPullBottomLevel: '15\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '1:00:00',
    etaToMax: '',
    timestamp: '',
  },
  {
    wellName: 'Stock Yards 2',
    route: 'Stock Yards',
    currentLevel: '8\'0"',
    lastPullBottomLevel: '8\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '1:30:00',
    etaToMax: '',
    timestamp: '',
  },
  {
    wellName: 'Stock Yards 3',
    route: 'Stock Yards',
    currentLevel: 'DOWN',
    isDown: true,
    lastPullBottomLevel: '3\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: 'Unknown',
    etaToMax: '',
    timestamp: '',
  },

  // Unrouted (1 well)
  {
    wellName: 'Wildcat 1',
    route: 'Unrouted',
    currentLevel: '11\'0"',
    lastPullBottomLevel: '11\'0"',
    lastPullDateTimeUTC: baseTime,
    timestampUTC: baseTime,
    bottomLevel: 3,
    tanks: 1,
    pullBbls: 140,
    bblPerFoot: 20,
    tankAtLevel: '1 @ 10\'0"',
    flowRate: '1:00:00',
    etaToMax: '',
    timestamp: '',
  },
];

test('route-scoped tab counts: Gabriels route counts only Gabriels wells', () => {
  const nowMs = Date.parse(baseTime) + 3600000;
  const counts = computeRouteViewCounts(mockWells, 'Gabriels', nowMs);

  // Gabriels has 5 total wells (none DOWN)
  assert.equal(counts.all, 5, 'All Wells for Gabriels route must be 5');
  // Gabriel 2, 3, 5 are pull-now (level >= 10ft target)
  assert.equal(counts['needs-pull'], 3, 'Needs Pull for Gabriels must count only Gabriels pull-now wells');
  // Gabriel 6 is approaching within 24h
  assert.equal(counts['next-24h'], 1, 'Next 24h for Gabriels must count only Gabriel 6');
  // Gabriel 7 has no level data
  assert.equal(counts['needs-data'], 1, 'Needs Data for Gabriels must count only Gabriel 7');
});

test('route-scoped tab counts: Stock Yards route counts only Stock Yards wells', () => {
  const nowMs = Date.parse(baseTime) + 3600000;
  const counts = computeRouteViewCounts(mockWells, 'Stock Yards', nowMs);

  // Stock Yards has 3 wells; Stock Yards 3 is DOWN. DOWN now appears in the ALL view,
  // so All Wells = 3, while the predictive buckets still exclude the DOWN well.
  assert.equal(counts.all, 3, 'All Wells for Stock Yards includes the DOWN well (visible, badged)');
  assert.equal(counts['needs-pull'], 1, 'Stock Yards 1 is pull-now (DOWN excluded)');
  assert.equal(counts['next-24h'], 1, 'Stock Yards 2 is approaching (DOWN excluded)');
  assert.equal(counts['needs-data'], 0, 'No needs-data wells in Stock Yards (DOWN is its own bucket)');
});

test('route-scoped tab counts: All Routes restores company-wide totals', () => {
  const nowMs = Date.parse(baseTime) + 3600000;
  const counts = computeRouteViewCounts(mockWells, 'all', nowMs);

  // 9 wells total, 1 DOWN. DOWN now appears in the ALL view, so All = 9; predictive
  // buckets still exclude the DOWN well.
  assert.equal(counts.all, 9, 'All Routes returns company-wide total incl. the DOWN well');
  assert.equal(counts['needs-pull'], 5, 'Needs pull includes Gabriels (3) + Stock Yards (1) + Wildcat (1)');
  assert.equal(counts['next-24h'], 2, 'Next 24h includes Gabriel 6 + Stock Yards 2');
  assert.equal(counts['needs-data'], 1, 'Needs data includes Gabriel 7');
});

test('source contract: page.tsx derives tab counts from routeWells, not raw wells', () => {
  const pagePath = fileURLToPath(new URL('../../app/dispatch/page.tsx', import.meta.url));
  const page = readFileSync(pagePath, 'utf8');

  // routeWells is computed from routeFilter
  assert.match(page, /const routeWells = useMemo\(\(\) => \{/);
  assert.match(page, /w\.route === routeFilter/);

  // needsPullSplit and viewCounts iterate over routeWells
  assert.match(page, /for \(const w of routeWells\)/);
  // DOWN wells remain excluded from the automatic Needs Pull prediction...
  assert.match(page, /if \(w\.isDown \|\| w\.currentLevel === 'DOWN'\) continue;/, 'DOWN excluded from Needs Pull split');
  // ...but ALL now counts every route well (DOWN appears in the ALL view, badged DOWN).
  assert.match(page, /'all': routeWells\.length,/, 'ALL counts every route well incl. DOWN');

  // search presentation shows N matching of M route wells (denominator = all route wells)
  assert.match(page, /matching of \$\{routeWells\.length\}/);
});
