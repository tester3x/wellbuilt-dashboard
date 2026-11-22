import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupTiming, sortDispatchJobs } from '../independentDispatchBoard.ts';
import type { IndependentJob } from '../independentDispatchJobs.ts';

const job = (id: string, scheduledAt: string, createdAt: string, updatedAt = createdAt): IndependentJob => ({
  id, companyId: 'test', revision: 1, status: 'unassigned', title: id, customer: 'Customer', reference: '',
  pickup: 'A', destination: 'B', cargo: '', scheduledAt, notes: '', createdAt, updatedAt,
});

test('active jobs show earliest requested pickup first, then oldest waiting unscheduled requests', () => {
  const jobs = [
    job('no-time-new', '', '2026-11-22T04:00:00.000Z'),
    job('sunday', '2026-11-29T18:00:00.000Z', '2026-11-21T04:00:00.000Z'),
    job('no-time-old', '', '2026-11-20T04:00:00.000Z', '2026-11-22T05:00:00.000Z'),
    job('today', '2026-11-22T18:00:00.000Z', '2026-11-22T03:00:00.000Z'),
  ];
  assert.deepEqual(sortDispatchJobs(jobs).map(item => item.id), ['today', 'sunday', 'no-time-old', 'no-time-new']);
  assert.deepEqual(jobs.map(item => item.id), ['no-time-new', 'sunday', 'no-time-old', 'today'], 'sort does not mutate fetched jobs');
});

test('pickup timing distinguishes passed, near, future, and unset requests', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  assert.equal(pickupTiming(job('past', '2026-11-22T11:00:00.000Z', ''), now), 'overdue');
  assert.equal(pickupTiming(job('near', '2026-11-23T11:00:00.000Z', ''), now), 'soon');
  assert.equal(pickupTiming(job('future', '2026-11-29T11:00:00.000Z', ''), now), 'later');
  assert.equal(pickupTiming(job('unset', '', ''), now), 'unscheduled');
});
