/**
 * Needs Pull assignment grouping (pure). Run:
 * node --test --experimental-strip-types src/lib/__tests__/dispatchAssignmentGroups.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pwLifecycle, partitionNeedsPull, type PwQueueItem } from '../dispatchAssignmentGroups.ts';

test('pwLifecycle maps statuses to lifecycle buckets', () => {
  for (const s of ['pending', 'pending_approval', 'accepted']) assert.equal(pwLifecycle(s), 'not_started', s);
  for (const s of ['in_progress', 'paused']) assert.equal(pwLifecycle(s), 'started', s);
  for (const s of ['declined', 'cancelled', 'dismissed', 'completed', '', null, undefined]) assert.equal(pwLifecycle(s as never), 'inactive');
});

const item = (o: Partial<PwQueueItem> & { key: string }): PwQueueItem => ({ isPullNow: true, predictedReadyAtMs: null, ...o });

test('two ordered groups: unassigned (by ready time) then assigned (by assigned-time)', () => {
  const items: PwQueueItem[] = [
    item({ key: 'U-late', predictedReadyAtMs: 3000 }),
    item({ key: 'A-2', assignedStatus: 'pending', assignedMs: 200 }),
    item({ key: 'U-soon', predictedReadyAtMs: 1000 }),
    item({ key: 'A-1', assignedStatus: 'accepted', assignedMs: 100 }),
  ];
  const { unassigned, assigned, counts } = partitionNeedsPull(items);
  assert.deepEqual(unassigned.map(i => i.key), ['U-soon', 'U-late']); // absolute ready time
  assert.deepEqual(assigned.map(i => i.key), ['A-1', 'A-2']);         // stable assigned-time
  assert.deepEqual(counts, { total: 4, unassigned: 2, assigned: 2 });
});

test('started wells are excluded (Active Jobs represents them)', () => {
  const { counts } = partitionNeedsPull([
    item({ key: 'started', assignedStatus: 'in_progress' }),
    item({ key: 'paused', assignedStatus: 'paused' }),
    item({ key: 'free' }),
  ]);
  assert.deepEqual(counts, { total: 1, unassigned: 1, assigned: 0 });
});

test('declined/cancelled/expired stop suppressing — well returns to Unassigned if still pull-now', () => {
  const declined = partitionNeedsPull([item({ key: 'w', assignedStatus: 'declined' })]);
  assert.deepEqual(declined.counts, { total: 1, unassigned: 1, assigned: 0 });
  assert.equal(declined.unassigned[0].key, 'w'); // restored to actionable
});

test('only physical demand counts (a non-pull-now assigned well is not in Needs Pull)', () => {
  const { counts } = partitionNeedsPull([
    item({ key: 'assigned-but-not-ready', assignedStatus: 'pending', isPullNow: false }),
    item({ key: 'assigned-ready', assignedStatus: 'pending', isPullNow: true, assignedMs: 5 }),
  ]);
  assert.deepEqual(counts, { total: 1, unassigned: 0, assigned: 1 });
});

test('assigned group is STABLE — ordering does not depend on live level / ready time', () => {
  const base: PwQueueItem[] = [
    item({ key: 'A', assignedStatus: 'pending', assignedMs: 10, predictedReadyAtMs: 9999 }),
    item({ key: 'B', assignedStatus: 'pending', assignedMs: 20, predictedReadyAtMs: 1 }),
  ];
  // Even though B would be "sooner" by ready time, assigned order stays by assigned-time.
  assert.deepEqual(partitionNeedsPull(base).assigned.map(i => i.key), ['A', 'B']);
});
