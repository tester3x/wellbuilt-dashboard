import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePhysicalJobs, orderPhysicalJobs, recommendedNextJobId, type PhysicalJobRankInput } from '../physicalJobOrder.ts';

const j = (o: Partial<PhysicalJobRankInput> & { id: string }): PhysicalJobRankInput => ({
  inProgress: false, down: false, sortOrder: 4, hoursUntilPull: 100, assignedAtMs: 0, ...o,
});

// Gabriels from the packet (readyAt order): G5 (7h31m) < G2 (1d7h) < G6 (1d7h53m) < G7 (1d8h) < G3 (2d6h)
test('assigned subset orders by physical readiness like the Well Queue', () => {
  const jobs = [
    j({ id: 'G3', sortOrder: 4, hoursUntilPull: 54.2 }),
    j({ id: 'G5', sortOrder: 2, hoursUntilPull: 7.5 }),
    j({ id: 'G7', sortOrder: 4, hoursUntilPull: 32.9 }),
    j({ id: 'G2', sortOrder: 4, hoursUntilPull: 31.4 }),
    j({ id: 'G6', sortOrder: 4, hoursUntilPull: 31.9 }),
  ];
  assert.deepEqual(orderPhysicalJobs(jobs).map((x) => x.id), ['G5', 'G2', 'G6', 'G7', 'G3']);
});

test('the in-progress job is pinned first regardless of physical readiness', () => {
  const jobs = [
    j({ id: 'G5', sortOrder: 2, hoursUntilPull: 7.5 }),
    j({ id: 'G3', inProgress: true, sortOrder: 4, hoursUntilPull: 54.2 }),
  ];
  assert.deepEqual(orderPhysicalJobs(jobs).map((x) => x.id), ['G3', 'G5']);
});

test('assignment status does not alter physical priority among non-in-progress jobs', () => {
  // Two jobs, same readiness inputs → deterministic tie-break by assignedAt then id.
  const a = j({ id: 'A', assignedAtMs: 200 });
  const b = j({ id: 'B', assignedAtMs: 100 });
  assert.deepEqual(orderPhysicalJobs([a, b]).map((x) => x.id), ['B', 'A']);
});

test('DOWN job stays visible (ordered) but is HELD from recommendation', () => {
  const jobs = [
    j({ id: 'thor', down: true, sortOrder: 999, hoursUntilPull: null }),
    j({ id: 'G5', sortOrder: 2, hoursUntilPull: 7.5 }),
  ];
  // Both present in the order (DOWN visible, sorts last by 999).
  assert.deepEqual(orderPhysicalJobs(jobs).map((x) => x.id), ['G5', 'thor']);
  // Recommended-next skips the DOWN job.
  assert.equal(recommendedNextJobId(jobs), 'G5');
});

test('recommended-next is the first eligible job; in-progress is never the recommendation', () => {
  const jobs = [
    j({ id: 'cur', inProgress: true, sortOrder: 1, hoursUntilPull: 0 }),
    j({ id: 'G5', sortOrder: 2, hoursUntilPull: 7.5 }),
    j({ id: 'G2', sortOrder: 4, hoursUntilPull: 31.4 }),
  ];
  assert.equal(recommendedNextJobId(jobs), 'G5'); // not 'cur'
});

test('DOWN is NOT categorically excluded from recommendation (a DOWN well may hold pullable water)', () => {
  // Only an in-progress job + a DOWN job → the DOWN job IS the recommendation (not null),
  // since DOWN no longer blocks recommendation; it just sorts to the DOWN tier.
  assert.equal(recommendedNextJobId([j({ id: 'cur', inProgress: true }), j({ id: 'd', down: true, sortOrder: 999 })]), 'd');
  // Only in-progress jobs → null.
  assert.equal(recommendedNextJobId([j({ id: 'cur', inProgress: true })]), null);
  // A ready non-DOWN job still wins over a DOWN one.
  assert.equal(recommendedNextJobId([j({ id: 'd', down: true, sortOrder: 999 }), j({ id: 'G5', sortOrder: 2, hoursUntilPull: 7.5 })]), 'G5');
});

test('a DOWN job that is already in progress is kept pinned (alert, not replaced)', () => {
  const jobs = [
    j({ id: 'G5', sortOrder: 2, hoursUntilPull: 7.5 }),
    j({ id: 'cur', inProgress: true, down: true, sortOrder: 999, hoursUntilPull: null }),
  ];
  assert.deepEqual(orderPhysicalJobs(jobs).map((x) => x.id), ['cur', 'G5']); // pinned despite DOWN
  assert.equal(recommendedNextJobId(jobs), 'G5'); // recommendation is the next eligible, not the pinned DOWN current
});

test('comparator is deterministic and total (stable ties)', () => {
  const x = j({ id: 'x' }), y = j({ id: 'y' });
  assert.equal(comparePhysicalJobs(x, y) < 0, true);
  assert.equal(comparePhysicalJobs(y, x) > 0, true);
  assert.equal(comparePhysicalJobs(x, x), 0);
});
