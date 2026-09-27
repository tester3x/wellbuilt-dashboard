import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWell, compareQueueRows } from '../dispatchPriority.ts';
import type { WellResponse } from '../wellPoolCore.ts';
import { orderDriverJobs, type RankableJob } from '../activeJobsRank.ts';

/**
 * THE invariant (packet "CORRECTION — ACTIVE JOBS ORDERING INPUTS DIVERGE"):
 *   Active Jobs order for a driver === the Well Queue order filtered to that
 *   driver's assigned canonical wells.
 * Exceptions: (1) the in-progress / started card is pinned first; (2) a DOWN well
 * stays VISIBLE (sorts to the DOWN tier, never removed).
 *
 * Both sides derive from ONE source: classifyWell + compareQueueRows at one nowMs,
 * joined by canonical NDIC identity. A regression that ranks Active Jobs by a stale
 * dispatch TTP / assignedAt / display-name equality would break these assertions.
 */

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const iso = (hAgo: number) => new Date(NOW - hAgo * 3600000).toISOString();

// bottomLevel(allowed)=5ft, tanks=1 → bblPerFoot=20 → readyFeet = 5 + 140/20 = 12ft.
const well = (name: string, ndic: string, o: Partial<WellResponse>): WellResponse =>
  ({ wellName: name, ndicName: ndic, bottomLevel: 5, tanks: 1, ...o } as WellResponse);

// Calibrated (see classifyWell): P pull-now, Q approaching (ready in 1h),
// R approaching (ready in 4h), D down. Queue order = P > Q > R > D.
const WELLS: WellResponse[] = [
  well('P', 'P-NDIC-33-155-01', { lastPullBottomLevel: '12', lastPullDateTimeUTC: iso(2), flowRate: '0:30:00' }),
  well('Q', 'Q-NDIC-33-155-02', { lastPullBottomLevel: '6', lastPullDateTimeUTC: iso(2), flowRate: '0:30:00' }),
  well('R', 'R-NDIC-33-155-03', { lastPullBottomLevel: '6', lastPullDateTimeUTC: iso(2), flowRate: '1:00:00' }),
  well('D', 'D-NDIC-33-155-04', { wellDown: true, lastPullBottomLevel: '6', lastPullDateTimeUTC: iso(2), flowRate: '0:30:00' } as Partial<WellResponse>),
];

/** The reference: Well Queue order (names) filtered to a set of assigned well names. */
function queueOrderFilteredTo(assignedWellNames: Set<string>): string[] {
  const rows = WELLS.map((w) => ({ well: w, priority: classifyWell(w, NOW), assignment: undefined }));
  rows.sort(compareQueueRows);
  return rows.map((r) => r.well.wellName).filter((n) => assignedWellNames.has(n));
}

/** A job that joins its well by canonical NDIC identity (never display-name). */
const job = (id: string, ndic: string, o: Partial<RankableJob> = {}): RankableJob =>
  ({ id, ndicWellName: ndic, wellName: `display-${id}`, assignedAtMs: 0, ...o });

const wellNameOfJob = (j: RankableJob): string => {
  // Resolve back through the same join the ranker uses, for assertion readability.
  const w = WELLS.find((x) => x.ndicName === j.ndicWellName);
  return w ? w.wellName : `<unmatched:${j.id}>`;
};

test('assigned subset renders in the SAME order as the Well Queue filtered to it', () => {
  // Driver assigned all four; assignedAt is the REVERSE of queue order so a stale
  // assignedAt-fallback regression would produce D,R,Q,P instead.
  const jobs = [
    job('jP', 'P-NDIC-33-155-01', { assignedAtMs: 4000 }),
    job('jQ', 'Q-NDIC-33-155-02', { assignedAtMs: 3000 }),
    job('jR', 'R-NDIC-33-155-03', { assignedAtMs: 2000 }),
    job('jD', 'D-NDIC-33-155-04', { assignedAtMs: 1000 }),
  ];
  const actual = orderDriverJobs(jobs, WELLS, NOW).map(wellNameOfJob);
  assert.deepEqual(actual, queueOrderFilteredTo(new Set(['P', 'Q', 'R', 'D'])));
  assert.deepEqual(actual, ['P', 'Q', 'R', 'D']);
  // Not the assignedAt order → proves ranking is physical, not assignment-time.
  assert.notDeepEqual(actual, ['D', 'R', 'Q', 'P']);
});

test('a PROPER assigned subset still matches the queue order filtered to it', () => {
  // Driver has only Q, R, D (not P). Order must be Q, R, D — the queue minus P.
  const jobs = [
    job('jD', 'D-NDIC-33-155-04', { assignedAtMs: 1000 }),
    job('jR', 'R-NDIC-33-155-03', { assignedAtMs: 2000 }),
    job('jQ', 'Q-NDIC-33-155-02', { assignedAtMs: 3000 }),
  ];
  const actual = orderDriverJobs(jobs, WELLS, NOW).map(wellNameOfJob);
  assert.deepEqual(actual, queueOrderFilteredTo(new Set(['Q', 'R', 'D'])));
  assert.deepEqual(actual, ['Q', 'R', 'D']);
});

test('two approaching wells order by ready TIME, not name or assignedAt (the G5/G6/G7 case)', () => {
  // Q is ready sooner than R though both are APPROACHING. Even with R assigned first
  // and R's display name sorting earlier, Q must precede R.
  const jobs = [
    job('jR', 'R-NDIC-33-155-03', { assignedAtMs: 1, wellName: 'AAA display' }),
    job('jQ', 'Q-NDIC-33-155-02', { assignedAtMs: 999, wellName: 'ZZZ display' }),
  ];
  assert.deepEqual(orderDriverJobs(jobs, WELLS, NOW).map(wellNameOfJob), ['Q', 'R']);
});

test('in-progress / Driver Started card is pinned first (exception 1)', () => {
  // R is started (driverStage) though it is the least-ready → pinned above P and Q.
  const jobs = [
    job('jP', 'P-NDIC-33-155-01'),
    job('jQ', 'Q-NDIC-33-155-02'),
    job('jR', 'R-NDIC-33-155-03', { driverStage: 'on_site' }),
  ];
  const actual = orderDriverJobs(jobs, WELLS, NOW).map(wellNameOfJob);
  assert.equal(actual[0], 'R'); // pinned
  assert.deepEqual(actual.slice(1), ['P', 'Q']); // remainder in queue order
});

test('DOWN assigned well stays VISIBLE in the order (exception 2 — never removed)', () => {
  const jobs = [
    job('jD', 'D-NDIC-33-155-04'),
    job('jP', 'P-NDIC-33-155-01'),
  ];
  const actual = orderDriverJobs(jobs, WELLS, NOW).map(wellNameOfJob);
  assert.ok(actual.includes('D'), 'DOWN job must remain visible');
  assert.deepEqual(actual, ['P', 'D']); // present, sorted to the DOWN tier (last)
});

test('join is by canonical NDIC identity — display name is irrelevant', () => {
  // Job carries a wrong/unrelated display name but the correct NDIC → joins Q, not a
  // display-name lookalike. (Guards against "GABRIEL 5-36-25TFH" → "Gabriel 5" by name.)
  const jobs = [job('jX', 'Q-NDIC-33-155-02', { wellName: 'GABRIEL 5-36-25TFH' })];
  assert.deepEqual(orderDriverJobs(jobs, WELLS, NOW).map(wellNameOfJob), ['Q']);
});

test('a job whose well cannot be joined sorts LAST — no stale fallback', () => {
  const jobs = [
    job('jGhost', 'NOT-IN-POOL-99', { assignedAtMs: 1 }), // no canonical well
    job('jP', 'P-NDIC-33-155-01', { assignedAtMs: 999 }),
  ];
  const ordered = orderDriverJobs(jobs, WELLS, NOW);
  assert.equal(ordered[0].id, 'jP');    // matched well ranks ahead
  assert.equal(ordered[1].id, 'jGhost'); // unjoined sinks to the bottom despite earlier assignedAt
});
