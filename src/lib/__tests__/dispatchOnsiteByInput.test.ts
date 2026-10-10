import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDispatchOnsiteByInput, parseDispatchOnsiteByInput } from '../dispatchOnsiteByInput.ts';

test('typed tablet arrival and picker value describe the same local time', () => {
  assert.equal(parseDispatchOnsiteByInput('10/10/2026 7:30 PM'), '2026-10-10T19:30');
  assert.equal(parseDispatchOnsiteByInput('10/10/2026 19:30'), '2026-10-10T19:30');
  assert.equal(formatDispatchOnsiteByInput('2026-10-10T19:30'), '10/10/2026 7:30 PM');
});

test('partial and invalid arrival times cannot become a dispatch time', () => {
  for (const value of ['10/', '10/10/2026', '13/10/2026 7:30 PM', '2/30/2026 7:30 PM', '10/10/2026 25:30']) {
    assert.equal(parseDispatchOnsiteByInput(value), null);
  }
});
