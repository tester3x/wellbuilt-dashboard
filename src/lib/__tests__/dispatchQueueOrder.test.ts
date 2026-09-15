/**
 * Well Queue ordering, assignment matching, and priority sort tests.
 *
 * Requirements:
 * - Overdue/needs-pull first, then ascending TTP globally.
 * - Gabriel 5 (10h TTP) must sort before Gabriel 2 (1d 10h), Gabriel 6 (1d 10h), Gabriel 7 (1d 11h), Gabriel 3 (2d 8h).
 * - Assignment is a secondary badge/state and must not demote urgent wells.
 * - Phone-created active jobs (Gabriel 3/7) must be recognized as assigned via matchWellInPool.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchQueueOrder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWell,
  compareQueueRows,
  sortQueueRows,
  type QueueRowItem,
  type WellClassification,
} from '../dispatchPriority.ts';
import { matchWellInPool } from '../wellPoolCore.ts';
import type { WellResponse } from '../wells.ts';

const BASE = Date.UTC(2026, 8, 15, 12, 0, 0); // Reference time: 2026-09-15 12:00:00Z
const ms = (hours: number) => BASE + hours * 3600_000;

function createTestWell(name: string, overrides: Partial<WellResponse> = {}): WellResponse {
  return {
    wellName: name,
    currentLevel: '--',
    etaToMax: '',
    flowRate: '0:30:00',
    timestamp: '',
    route: 'Route 1',
    tanks: 1,
    pullBbls: 140,
    bottomLevel: 3,
    bblPerFoot: 20,
    tankAtLevel: "1 @ 10'0\"",
    ...overrides,
  };
}

test('matchWellInPool matches exact short names and NDIC names', () => {
  const pool: WellResponse[] = [
    createTestWell('Gabriel 3', { ndicName: 'GABRIEL 3-36-25H' }),
    createTestWell('Gabriel 5', { ndicName: 'GABRIEL 5-36-25TFH' }),
    createTestWell('Gabriel 6', { ndicName: 'GABRIEL 6-36-25TFH' }),
    createTestWell('Gabriel 7', { ndicName: 'GABRIEL 7-36-25TFH' }),
    createTestWell('Thor 1', { ndicName: 'THOR  1-31-30H' }),
  ];

  // Exact short name
  assert.equal(matchWellInPool(pool, 'Gabriel 5')?.wellName, 'Gabriel 5');
  assert.equal(matchWellInPool(pool, 'Thor 1')?.wellName, 'Thor 1');

  // Phone-created NDIC names
  assert.equal(matchWellInPool(pool, 'GABRIEL 3-36-25H')?.wellName, 'Gabriel 3');
  assert.equal(matchWellInPool(pool, 'GABRIEL 7-36-25TFH')?.wellName, 'Gabriel 7');
  assert.equal(matchWellInPool(pool, 'THOR  1-31-30H')?.wellName, 'Thor 1');

  // Whitespace / casing variations
  assert.equal(matchWellInPool(pool, 'thor 1')?.wellName, 'Thor 1');
  assert.equal(matchWellInPool(pool, 'THOR 1-31-30H')?.wellName, 'Thor 1');
  assert.equal(matchWellInPool(pool, 'gabriel 3')?.wellName, 'Gabriel 3');
});

test('matchWellInPool matches prefix well name even if catalog ndicName is blank', () => {
  const pool: WellResponse[] = [
    createTestWell('Gabriel 3', { ndicName: '' }),
    createTestWell('Gabriel 7', { ndicName: '' }),
  ];

  assert.equal(matchWellInPool(pool, 'GABRIEL 3-36-25H')?.wellName, 'Gabriel 3');
  assert.equal(matchWellInPool(pool, 'GABRIEL 7-36-25TFH')?.wellName, 'Gabriel 7');
});

test('Global sort order: Gabriel 5 (10h) sorts before Gabriel 2, 6, 7, 3 regardless of assignment', () => {
  const g5 = createTestWell('Gabriel 5');
  const g2 = createTestWell('Gabriel 2');
  const g6 = createTestWell('Gabriel 6');
  const g7 = createTestWell('Gabriel 7');
  const g3 = createTestWell('Gabriel 3');

  const makeApproaching = (readyAtMs: number): WellClassification => ({
    state: 'approaching',
    label: 'APPROACHING',
    color: 'bg-yellow-600',
    textColor: 'text-black',
    sortOrder: 2,
    targetInches: 120,
    lastLevel: "6'",
    lastLevelInches: 72,
    lastLevelAgeHours: 2,
    estInches: 84,
    remainingInches: 36,
    ttpHours: (readyAtMs - BASE) / 3600_000,
    gainValid: true,
    fresh: true,
    estFeet: 7,
    estDisplay: "7'",
    readyFeet: 10,
    predictedReadyAtMs: readyAtMs,
    hasFlow: true,
    availableLoads: 0,
  });

  const items: QueueRowItem[] = [
    {
      well: g3,
      priority: makeApproaching(ms(56)), // 2d 8h (56h)
      assignment: { state: 'assigned_not_started', driver: 'Mike', status: 'pending' },
    },
    {
      well: g7,
      priority: makeApproaching(ms(35)), // 1d 11h (35h)
      assignment: { state: 'assigned_not_started', driver: 'Mike', status: 'pending' },
    },
    {
      well: g2,
      priority: makeApproaching(ms(34)), // 1d 10h (34h)
      assignment: null,
    },
    {
      well: g6,
      priority: makeApproaching(ms(34)), // 1d 10h (34h)
      assignment: { state: 'assigned_not_started', driver: 'Mike', status: 'pending' },
    },
    {
      well: g5,
      priority: makeApproaching(ms(10)), // 10h TTP - MOST URGENT
      assignment: { state: 'assigned_not_started', driver: 'Mike', status: 'pending' },
    },
  ];

  const sorted = sortQueueRows(items);

  // Gabriel 5 (10h) must be first!
  assert.equal(sorted[0].well.wellName, 'Gabriel 5');
  // Then Gabriel 2 and 6 (both 34h, tiebroken alphabetically: Gabriel 2, Gabriel 6)
  assert.equal(sorted[1].well.wellName, 'Gabriel 2');
  assert.equal(sorted[2].well.wellName, 'Gabriel 6');
  // Then Gabriel 7 (35h)
  assert.equal(sorted[3].well.wellName, 'Gabriel 7');
  // Finally Gabriel 3 (56h)
  assert.equal(sorted[4].well.wellName, 'Gabriel 3');
});

test('Urgent assigned well is NEVER demoted behind unassigned less-urgent well', () => {
  const urgentWell = createTestWell('Urgent Well');
  const distantWell = createTestWell('Distant Well');

  const priorityUrgent: WellClassification = {
    state: 'approaching',
    label: 'APPROACHING',
    color: 'bg-yellow-600',
    textColor: 'text-black',
    sortOrder: 2,
    targetInches: 120,
    lastLevel: "8'",
    lastLevelInches: 96,
    lastLevelAgeHours: 1,
    estInches: 108,
    remainingInches: 12,
    ttpHours: 4,
    gainValid: true,
    fresh: true,
    estFeet: 9,
    estDisplay: "9'",
    readyFeet: 10,
    predictedReadyAtMs: ms(4), // 4 hours away
    hasFlow: true,
    availableLoads: 0,
  };

  const priorityDistant: WellClassification = {
    state: 'approaching',
    label: 'APPROACHING',
    color: 'bg-yellow-600',
    textColor: 'text-black',
    sortOrder: 2,
    targetInches: 120,
    lastLevel: "4'",
    lastLevelInches: 48,
    lastLevelAgeHours: 1,
    estInches: 60,
    remainingInches: 60,
    ttpHours: 48,
    gainValid: true,
    fresh: true,
    estFeet: 5,
    estDisplay: "5'",
    readyFeet: 10,
    predictedReadyAtMs: ms(48), // 48 hours away
    hasFlow: true,
    availableLoads: 0,
  };

  const rows: QueueRowItem[] = [
    {
      well: distantWell,
      priority: priorityDistant,
      assignment: null, // UNASSIGNED
    },
    {
      well: urgentWell,
      priority: priorityUrgent,
      assignment: { state: 'assigned_not_started', driver: 'Driver 1', status: 'pending' }, // ASSIGNED
    },
  ];

  const sorted = sortQueueRows(rows);
  assert.equal(sorted[0].well.wellName, 'Urgent Well', 'Assigned urgent well must sort before unassigned distant well');
  assert.equal(sorted[1].well.wellName, 'Distant Well');
});

test('Overdue / pull-now wells sort before approaching wells', () => {
  const pullNowWell = createTestWell('Pull Now Well');
  const approachingWell = createTestWell('Approaching Well');

  const priorityPullNow: WellClassification = {
    state: 'pull-now',
    label: 'PULL NOW',
    color: 'bg-red-600',
    textColor: 'text-white',
    sortOrder: 1,
    targetInches: 120,
    lastLevel: "10'",
    lastLevelInches: 120,
    lastLevelAgeHours: 1,
    estInches: 124,
    remainingInches: 0,
    ttpHours: 0,
    gainValid: true,
    fresh: true,
    estFeet: 10.3,
    estDisplay: "10'4\"",
    readyFeet: 10,
    predictedReadyAtMs: ms(-1), // ready 1 hour ago
    hasFlow: true,
    availableLoads: 1,
  };

  const priorityApproaching: WellClassification = {
    state: 'approaching',
    label: 'APPROACHING',
    color: 'bg-yellow-600',
    textColor: 'text-black',
    sortOrder: 2,
    targetInches: 120,
    lastLevel: "8'",
    lastLevelInches: 96,
    lastLevelAgeHours: 1,
    estInches: 108,
    remainingInches: 12,
    ttpHours: 2,
    gainValid: true,
    fresh: true,
    estFeet: 9,
    estDisplay: "9'",
    readyFeet: 10,
    predictedReadyAtMs: ms(2),
    hasFlow: true,
    availableLoads: 0,
  };

  const rows: QueueRowItem[] = [
    { well: approachingWell, priority: priorityApproaching, assignment: null },
    { well: pullNowWell, priority: priorityPullNow, assignment: null },
  ];

  const sorted = sortQueueRows(rows);
  assert.equal(sorted[0].well.wellName, 'Pull Now Well');
  assert.equal(sorted[1].well.wellName, 'Approaching Well');
});
