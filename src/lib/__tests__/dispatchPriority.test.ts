/**
 * HEIGHT-FIRST classification tests (fixed clock; no Firebase).
 *
 * Governing rule: a well is pullable because its TRUSTWORTHY level reached the
 * configured pull-height target — never because time elapsed. Time only feeds a
 * bounded estimate while a positive-gain model is valid. No OVERDUE for
 * unassigned predictions.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchPriority.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWell, formatTTP, matchesView, wellBucket, hasValidPrediction, inchesToLevel,
} from '../dispatchPriority.ts';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000).toISOString();
const w = (o: Record<string, unknown>) => o as never;
const TARGET = "2 @ 7'6\""; // 90 inches

test('FIXTURE: 1\'3" + 136 days old + no gain is NOT pullable (VERIFY, never OVER)', () => {
  const barbarian = w({ tankAtLevel: TARGET, currentLevel: "1'3\"", currentLevelInches: 15, timestampUTC: iso(-136 * 24) });
  const c = classifyWell(barbarian, NOW);
  assert.equal(c.state, 'verify');
  assert.equal(formatTTP(barbarian, NOW), 'VERIFY');
  assert.equal(matchesView(barbarian, 'needs-pull', NOW), false);
  assert.equal(matchesView(barbarian, 'next-24h', NOW), false);
  assert.equal(matchesView(barbarian, 'needs-data', NOW), true);
  assert.notEqual(formatTTP(barbarian, NOW), 'OVERDUE');
});

test('FIXTURE: not marked Down but flat/no gain (recent) is NOT pullable (NO GAIN)', () => {
  const flat = w({ tankAtLevel: TARGET, currentLevelInches: 40, timestampUTC: iso(-2), windowBblsDay: '0' });
  const c = classifyWell(flat, NOW);
  assert.equal(c.state, 'no-gain');
  assert.equal(matchesView(flat, 'needs-pull', NOW), false);
  assert.equal(matchesView(flat, 'next-24h', NOW), false);
  assert.equal(matchesView(flat, 'needs-data', NOW), true);
});

test('FIXTURE: recent below-target level with validated gain is APPROACHING (remaining + TTP)', () => {
  const app = w({ tankAtLevel: TARGET, currentLevelInches: 70, timestampUTC: iso(-2), windowBblsDay: '120', bblPerFoot: 20 });
  const c = classifyWell(app, NOW);
  assert.equal(c.state, 'approaching');
  assert.equal(c.remainingInches, 20);          // 90 - 70
  assert.ok(c.ttpHours !== null && Math.abs(c.ttpHours - 6.667) < 0.1, 'TTP ~6.7h at 3"/hr'); // (120/24)/20*12 = 3 in/hr
  assert.equal(matchesView(app, 'next-24h', NOW), true);
});

test('FIXTURE: trustworthy height at/above target is PULL NOW', () => {
  const ready = w({ tankAtLevel: TARGET, currentLevelInches: 95, timestampUTC: iso(-2), windowBblsDay: '120' });
  const c = classifyWell(ready, NOW);
  assert.equal(c.state, 'pull-now');
  assert.equal(formatTTP(ready, NOW), 'PULL NOW');
  assert.equal(matchesView(ready, 'needs-pull', NOW), true);
});

test('FIXTURE: invalidating the AFR (gain→0) removes the well from Needs Pull AND Next 24h', () => {
  const base = { tankAtLevel: TARGET, currentLevelInches: 70, timestampUTC: iso(-2), bblPerFoot: 20 };
  const gaining = w({ ...base, windowBblsDay: '120' });
  assert.equal(matchesView(gaining, 'next-24h', NOW), true);
  const invalidated = w({ ...base, windowBblsDay: '0' }); // AFR/gain evidence gone
  assert.equal(matchesView(invalidated, 'next-24h', NOW), false);
  assert.equal(matchesView(invalidated, 'needs-pull', NOW), false);
  assert.equal(classifyWell(invalidated, NOW).state, 'no-gain');
});

test('FIXTURE: time passing by itself never changes a well to PULL NOW', () => {
  const flat = w({ tankAtLevel: TARGET, currentLevelInches: 40, timestampUTC: iso(-2), windowBblsDay: '0' });
  assert.equal(classifyWell(flat, NOW).state, 'no-gain');
  // advance the clock 200h — the same fixed reading just gets STALE, never pullable
  const later = NOW + 200 * 3600_000;
  const c2 = classifyWell(flat, later);
  assert.equal(c2.state, 'verify');
  assert.notEqual(c2.state, 'pull-now');
});

test('FIXTURE: badge, height, TTP, counter/bucket, filter, and assignment eligibility all agree', () => {
  const ready = w({ tankAtLevel: TARGET, currentLevelInches: 95, timestampUTC: iso(-2), windowBblsDay: '120' });
  const c = classifyWell(ready, NOW);
  assert.equal(c.state, 'pull-now');                          // badge
  assert.equal(c.label, 'PULL NOW');
  assert.equal(formatTTP(ready, NOW), 'PULL NOW');            // TTP
  assert.equal(wellBucket(ready, NOW), 'needs-pull');         // counter/bucket
  assert.equal(matchesView(ready, 'needs-pull', NOW), true);  // filter
  assert.equal(hasValidPrediction(ready, NOW), true);
  // assignment eligibility: an already-assigned well is ASSIGNED, not freely pullable
  assert.equal(classifyWell(ready, NOW, { assigned: true }).state, 'assigned');
  assert.equal(matchesView(ready, 'needs-pull', NOW, { assigned: true }), false);
});

test('DOWN wells never appear in any actionable view', () => {
  const down = w({ tankAtLevel: TARGET, currentLevelInches: 95, isDown: true, timestampUTC: iso(-2) });
  assert.equal(classifyWell(down, NOW).state, 'down');
  for (const v of ['needs-pull', 'next-24h', 'all', 'needs-data'] as const) {
    assert.equal(matchesView(down, v, NOW), false);
  }
});

test('missing target or level → NEEDS DATA / VERIFY (needs-data view)', () => {
  const noTarget = w({ currentLevelInches: 95, timestampUTC: iso(-2) });
  assert.equal(classifyWell(noTarget, NOW).state, 'verify');
  assert.equal(matchesView(noTarget, 'needs-data', NOW), true);
  assert.equal(matchesView(noTarget, 'needs-pull', NOW), false);
});

test('inchesToLevel formats feet/inches', () => {
  assert.equal(inchesToLevel(90), "7'6\"");
  assert.equal(inchesToLevel(15), "1'3\"");
  assert.equal(inchesToLevel(null), '--');
});

test('LIFECYCLE: a status-less catalog well classifies as VERIFY (justifies queue-level UNAVAILABLE, not fabricated needs-data)', () => {
  // What a catalog-only fallback (no live status) would yield per-well:
  const catalogOnly = w({ wellName: 'X', route: 'R' }); // no target, no level, no gain
  const c = classifyWell(catalogOnly, NOW);
  assert.equal(c.state, 'verify');
  // The page must NOT fabricate 80 of these on a failed read — it shows a
  // queue-level UNAVAILABLE instead (asserted structurally in controlContracts).
});
