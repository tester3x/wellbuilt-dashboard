import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveDispatchCard } from '../dispatchActiveVisibility.ts';
test('reassignment removes old cancelled card but keeps the destination assignment', () => {
  assert.equal(isActiveDispatchCard({status:'cancelled',reassignedTo:'New driver'}), false);
  assert.equal(isActiveDispatchCard({status:'pending'}), true);
});
test('driver rejection and unreassigned cancellation remain actionable', () => {
  assert.equal(isActiveDispatchCard({status:'declined'}), true);
  assert.equal(isActiveDispatchCard({status:'cancelled'}), true);
  assert.equal(isActiveDispatchCard({status:'declined',reassignedTo:'Old metadata'}), true);
  assert.equal(isActiveDispatchCard({status:'cancelled',reassignedTo:' '}), true);
});
test('finished and dismissed jobs stay outside Active Jobs', () => {
  for(const status of ['completed','dismissed']) assert.equal(isActiveDispatchCard({status}),false);
});
