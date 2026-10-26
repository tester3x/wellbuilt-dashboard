import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannedDriverShift, preDispatchBlocked } from '../driverWeeklySchedule.ts';

test('regular day off does not prevent a dated work assignment', () => {
  const driver = { usualShift: 'day' as const, weeklyDaysOff: [0, 6], shiftPlan: { '2026-10-25': 'night' as const } };
  assert.equal(plannedDriverShift(driver, '2026-10-24'), 'off');
  assert.equal(plannedDriverShift(driver, '2026-10-25'), 'night');
  assert.equal(plannedDriverShift(driver, '2026-10-26'), 'day');
  assert.equal(plannedDriverShift(driver, '2026-02-30'), null);
  assert.equal(preDispatchBlocked(driver, '2026-10-25', 'Off shift', '2026-10-25'), true);
  assert.equal(preDispatchBlocked(driver, '2026-10-25', 'On shift', '2026-10-25'), false);
  assert.equal(preDispatchBlocked(driver, '2026-10-25', 'On shift', '2026-10-24'), true);
  assert.equal(preDispatchBlocked(driver, '2026-10-26', 'Off shift', '2026-10-26'), false);
});
