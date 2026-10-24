import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveDispatchCard, isCancelledDispatchCard } from '../dispatchActiveVisibility.ts';
test('reassignment removes old cancelled card but keeps the destination assignment', () => {
  assert.equal(isActiveDispatchCard({status:'cancelled',reassignedTo:'New driver'}), false);
  assert.equal(isActiveDispatchCard({status:'pending'}), true);
});
test('driver rejection and cancellation leave Active Jobs for dispatch review', () => {
  assert.equal(isActiveDispatchCard({status:'declined'}), false);
  assert.equal(isActiveDispatchCard({status:'cancelled'}), false);
  assert.equal(isActiveDispatchCard({status:'declined',reassignedTo:'Old metadata'}), false);
  assert.equal(isActiveDispatchCard({status:'cancelled',reassignedTo:' '}), false);
});
test('finished and dismissed jobs stay outside Active Jobs', () => {
  for(const status of ['completed','dismissed']) assert.equal(isActiveDispatchCard({status}),false);
});

test('review tab shows only jobs still waiting for a dispatch decision', () => {
 for(const status of ['cancelled','declined']) assert.equal(isCancelledDispatchCard({status}),true);
 for(const status of ['pending','pending_approval','accepted','in_progress','paused','completed','dismissed']) assert.equal(isCancelledDispatchCard({status}),false);
 assert.equal(isCancelledDispatchCard({status:'cancelled',reassignedTo:'New driver'}),false);
 assert.equal(isCancelledDispatchCard({status:'cancelled',reassignedTo:' '}),true);
});
