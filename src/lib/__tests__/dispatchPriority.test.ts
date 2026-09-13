/**
 * RUNTIME tests for Dispatch PW-queue priority + TTP (src/lib/dispatchPriority.ts).
 * Pure functions with an injectable `nowMs` — deterministic, no Firebase.
 *
 * Core regression: the TTP column must be as LIVE as the priority badge. A well
 * whose nextPullTimeUTC is in the past but whose server-snapshot timeTillPull
 * string is still positive must read OVERDUE in BOTH the badge and the TTP text.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchPriority.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPriority, formatTTP } from '../dispatchPriority.ts';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0); // fixed clock
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000).toISOString();
// minimal WellResponse-ish fixture
const w = (o: Record<string, unknown>) => o as never;

test('getPriority buckets from live nextPullTimeUTC', () => {
  assert.equal(getPriority(w({ nextPullTimeUTC: iso(-1) }), NOW).level, 'overdue');
  assert.equal(getPriority(w({ nextPullTimeUTC: iso(3) }), NOW).level, 'soon');
  assert.equal(getPriority(w({ nextPullTimeUTC: iso(12) }), NOW).level, 'today');
  assert.equal(getPriority(w({ nextPullTimeUTC: iso(48) }), NOW).level, 'later');
  assert.ok(getPriority(w({ nextPullTimeUTC: iso(-5) }), NOW).hoursUntilPull! < 0, 'overdue hoursUntilPull negative → sorts most-overdue-first');
});

test('getPriority: DOWN and string fallbacks', () => {
  assert.equal(getPriority(w({ isDown: true }), NOW).label, 'DOWN');
  assert.equal(getPriority(w({ timeTillPull: 'Ready' }), NOW).level, 'overdue');
  assert.equal(getPriority(w({ timeTillPull: '2d 3h' }), NOW).level, 'later');
  assert.equal(getPriority(w({ timeTillPull: '3h' }), NOW).level, 'soon');
  assert.equal(getPriority(w({}), NOW).level, 'unknown');
});

test('formatTTP is live and consistent with the badge', () => {
  assert.equal(formatTTP(w({ nextPullTimeUTC: iso(-2) }), NOW), 'OVERDUE');
  assert.equal(formatTTP(w({ nextPullTimeUTC: iso(3) }), NOW), '3h');
  assert.equal(formatTTP(w({ nextPullTimeUTC: iso(50) }), NOW), '2d 2h');
  assert.equal(formatTTP(w({ nextPullTimeUTC: iso(48) }), NOW), '2d');
});

test('REGRESSION: stale timeTillPull string does NOT override a live-overdue nextPullTimeUTC', () => {
  // Server snapshot said "5h 20m" hours ago; nextPullTimeUTC is now in the past.
  const well = w({ nextPullTimeUTC: iso(-3), timeTillPull: '5h 20m' });
  assert.equal(getPriority(well, NOW).level, 'overdue', 'badge is live-overdue');
  assert.equal(formatTTP(well, NOW), 'OVERDUE', 'TTP text is live-overdue, not the stale "5h 20m"');
});

test('formatTTP falls back to the raw string only when there is no live/parsed time', () => {
  assert.equal(formatTTP(w({ isDown: true, timeTillPull: 'n/a' }), NOW), 'n/a');
  assert.equal(formatTTP(w({}), NOW), '--');
});

// ─── Actionable queue fixtures (fixed clock; the contradictions observed live) ─
import { wellBucket, matchesView, assessLevel, hasValidPrediction } from '../dispatchPriority.ts';

test('FIXTURE: historical 1\'3" last level + elapsed nextPullTimeUTC → overdue, level labeled historical (not current)', () => {
  const well = w({ nextPullTimeUTC: iso(-10), lastPullDateTimeUTC: iso(-30), lastPullBottomLevel: "1'3\"" });
  assert.equal(getPriority(well, NOW).level, 'overdue');
  assert.equal(formatTTP(well, NOW), 'OVERDUE');
  const lv = assessLevel(well, NOW);
  assert.equal(lv.lastLevel, "1'3\"", 'last measured reading preserved');
  assert.equal(lv.estNow, 'OVER', 'estimated-now is OVER, never presents 1\'3" as current');
  assert.equal(lv.isHistoricalOnly, true);
  assert.equal(wellBucket(well, NOW), 'needs-pull');
});

test('FIXTURE: ~232h TTP must NOT show overdue', () => {
  const well = w({ nextPullTimeUTC: iso(232) });
  assert.equal(getPriority(well, NOW).level, 'later');
  assert.notEqual(formatTTP(well, NOW), 'OVERDUE');
  assert.equal(formatTTP(well, NOW), '9d 16h');
  assert.equal(wellBucket(well, NOW), 'later');
});

test('FIXTURE: TTP and badge never disagree about whether ready-time passed', () => {
  for (const off of [-100, -1, -0.1, 0.1, 3, 12, 48, 232]) {
    const well = w({ nextPullTimeUTC: iso(off) });
    const overduBadge = getPriority(well, NOW).level === 'overdue';
    const overdueTTP = formatTTP(well, NOW) === 'OVERDUE';
    assert.equal(overduBadge, overdueTTP, `offset ${off}h: badge/TTP agree on overdue`);
  }
});

test('FIXTURE: missing prediction data → NEEDS DATA (never a stale snapshot)', () => {
  const well = w({ currentLevel: '--' });
  assert.equal(wellBucket(well, NOW), 'needs-data');
  assert.equal(hasValidPrediction(well, NOW), false);
  assert.equal(assessLevel(well, NOW).estNow, 'NEEDS DATA');
});

test('FIXTURE: default Needs Pull excludes wells days away; includes overdue', () => {
  const daysAway = w({ nextPullTimeUTC: iso(72) });
  const overdue = w({ nextPullTimeUTC: iso(-2) });
  assert.equal(matchesView(daysAway, 'needs-pull', NOW), false);
  assert.equal(matchesView(overdue, 'needs-pull', NOW), true);
});

test('FIXTURE: Next 24h includes upcoming wells across different routes', () => {
  const a = w({ nextPullTimeUTC: iso(5), route: 'Route A' });
  const b = w({ nextPullTimeUTC: iso(20), route: 'Route B' });
  const far = w({ nextPullTimeUTC: iso(48), route: 'Route C' });
  assert.equal(matchesView(a, 'next-24h', NOW), true);
  assert.equal(matchesView(b, 'next-24h', NOW), true);
  assert.equal(matchesView(far, 'next-24h', NOW), false, 'a 48h well is not "next 24h"');
});

test('FIXTURE: DOWN wells never appear as freely assignable in any view', () => {
  const down = w({ isDown: true, nextPullTimeUTC: iso(-5) });
  assert.equal(wellBucket(down, NOW), 'down');
  for (const v of ['needs-pull', 'next-24h', 'all', 'needs-data'] as const) {
    assert.equal(matchesView(down, v, NOW), false, `down excluded from ${v}`);
  }
});
