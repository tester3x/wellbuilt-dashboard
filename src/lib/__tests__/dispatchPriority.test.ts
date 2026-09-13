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
