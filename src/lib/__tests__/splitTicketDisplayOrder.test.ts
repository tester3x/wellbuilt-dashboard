import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSplitTicketChains } from '../splitTicketDisplayOrder.ts';

const job = (id: string, splitGroupId?: string, splitSequence?: number) => ({
  id,
  jobType: splitGroupId ? 'service' : 'pw',
  splitGroupId,
  splitSequence,
});

test('linked split tickets display A, B, C while unrelated jobs keep physical order', () => {
  const physical = [job('first'), job('B', 'split-1', 2), job('other'), job('C', 'split-1', 3), job('A', 'split-1', 1), job('last')];
  assert.deepEqual(orderSplitTicketChains(physical).map(j => j.id), ['first', 'A', 'B', 'C', 'other', 'last']);
  assert.deepEqual(physical.map(j => j.id), ['first', 'B', 'other', 'C', 'A', 'last']);
});

test('separate chains stay separate and incomplete sequence metadata sorts last', () => {
  const physical = [job('B2', 'split-2', 2), job('C1', 'split-1', 3), job('A2', 'split-2', 1), job('unknown1', 'split-1'), job('B1', 'split-1', 2)];
  assert.deepEqual(orderSplitTicketChains(physical).map(j => j.id), ['A2', 'B2', 'B1', 'C1', 'unknown1']);
});
