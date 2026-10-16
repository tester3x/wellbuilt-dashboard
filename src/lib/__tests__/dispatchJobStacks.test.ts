import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDispatchRows, type StackableDispatch } from '../dispatchJobStacks.ts';

test('multi-haul groups different active wells while retaining separate jobs', () => {
  const a = job('a', { status: 'in_progress', driverStage: 'en_route_dropoff' });
  const b = job('b', { status: 'paused', wellName: 'OTHER WELL' });
  const rows = groupDispatchRows([a, b], () => 'trip-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].multiHaul, true);
  assert.deepEqual(rows[0].jobs, [a, b]);
  assert.strictEqual(rows[0].jobs[0], a);
});

test('multi-haul cannot combine different trips, tenants, or drivers', () => {
  const a = job('a', { status: 'in_progress' });
  for (const change of [{ companyId: 'other' }, { driverHash: 'other' }]) {
    assert.equal(groupDispatchRows([a, job('b', { status: 'in_progress', ...change })], () => 'trip-1').length, 2);
  }
  assert.equal(groupDispatchRows([a, job('b', { status: 'in_progress' })], j => j.id!).length, 2);
});

test('clearing invoice membership returns active jobs to independent cards', () => {
  const jobs = [job('a', { status: 'in_progress' }), job('b', { status: 'in_progress' })];
  assert.equal(groupDispatchRows(jobs, () => '').length, 2);
});

function job(id: string, overrides: Partial<StackableDispatch> = {}): StackableDispatch {
  return {
    id, companyId: 'liquid-gold', driverHash: 'mike', driverName: 'Mike',
    wellName: 'CYCLONE 1-21-16H', ndicWellName: 'CYCLONE 1-21-16H',
    jobType: 'pw', status: 'pending', source: 'driver',
    assignedBy: 'mike', disposal: 'ALAT ARNEGARD SWD 1',
    loadCount: 1, ...overrides,
  };
}

test('identical app cards stack without losing dispatch identities or priority order', () => {
  const first = job('first');
  const other = job('other', { wellName: 'GABRIEL 5', ndicWellName: 'GABRIEL 5' });
  const second = job('second');
  const rows = groupDispatchRows([first, other, second]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].remainingLoads, 2);
  assert.deepEqual(rows[0].jobs.map(j => j.id), ['first', 'second']);
  assert.strictEqual(rows[0].jobs[0], first);
  assert.strictEqual(rows[0].jobs[1], second);
  assert.deepEqual(rows[1].jobs.map(j => j.id), ['other']);
});

test('same well and SWD do not hide a different creator, origin, ticket, or job detail', () => {
  const base = job('base');
  const differences = [
    { assignedBy: 'dispatcher-2' },
    { source: undefined },
    { companyId: 'other-company' },
    { driverHash: 'other-driver' },
    { disposal: 'OTHER SWD' },
    { notes: 'Check access gate' },
    { ticketNumber: 'T-2' },
    { priority: 2 },
    { isHeavyWater: true },
    { ndicWellName: 'CYCLONE 1-21-10H' },
  ];
  for (const [index, difference] of differences.entries()) {
    const rows = groupDispatchRows([base, job(String(index), difference)]);
    assert.equal(rows.length, 2, JSON.stringify(difference));
  }
});

test('active, partially completed, linked, transfer and unknown-origin cards stay independent', () => {
  const variations = [
    { status: 'in_progress' }, { driverStage: 'en_route_pickup' },
    { loadsCompleted: 1, loadCount: 2 }, { splitGroupId: 'split-1' },
    { serviceGroupId: 'crew-1' }, { projectId: 'project-1' },
    { type: 'transfer' }, { jobType: 'service' },
    { source: undefined, assignedBy: undefined },
  ];
  for (const variation of variations) {
    assert.equal(groupDispatchRows([job('a', variation), job('b', variation)]).length, 2);
  }
});
