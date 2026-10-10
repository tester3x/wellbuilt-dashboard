import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDispatchOnsiteByInput, parseDispatchOnsiteByInput } from '../dispatchOnsiteByInput.ts';

test('typed tablet deadline becomes the same local value as the picker', () => {
  assert.equal(parseDispatchOnsiteByInput('10/09/2026 7:30 PM'), '2026-10-09T19:30');
  assert.equal(parseDispatchOnsiteByInput('10/9/2026 19:30'), '2026-10-09T19:30');
  assert.equal(parseDispatchOnsiteByInput('10/9/2026 12:05 AM'), '2026-10-09T00:05');
  assert.equal(formatDispatchOnsiteByInput('2026-10-09T19:30'), '10/09/2026 7:30 PM');
});

test('invalid typed deadlines cannot become a dispatch deadline', () => {
  for (const value of ['2/30/2026 7:30 PM', '10/09/2026 13:30 PM', '10/09/2026 25:30', '10/09/2026 7:60 PM', '10/09/2026 7:3 PM', '']) {
    assert.equal(parseDispatchOnsiteByInput(value), null);
  }
});
