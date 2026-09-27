import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareQueueRows, type QueueRowItem, type WellClassification } from '../dispatchPriority.ts';
import type { WellResponse } from '../wellPoolCore.ts';

const baseWell = (name: string): WellResponse => ({
  wellName: name,
  route: 'Gabriels',
  currentLevel: '14\'0"',
  bottomLevel: 3,
  tanks: 1,
  pullBbls: 140,
  tankAtLevel: '1 @ 10\'0"',
  flowRate: '1:00:00',
  timestampUTC: new Date(1700000000000).toISOString(),
  etaToMax: '',
  timestamp: '',
});

const basePriority = (state: 'pull-now' | 'approaching' | 'no-gain' | 'verify' | 'down', readyMs: number | null): WellClassification => ({
  state,
  label: state === 'pull-now' ? 'PULL NOW' : state.toUpperCase(),
  color: 'bg-red-600',
  textColor: 'text-white',
  sortOrder: state === 'pull-now' ? 1 : state === 'approaching' ? 2 : 50,
  predictedReadyAtMs: readyMs,
  targetInches: 120,
  lastLevel: '14\'0"',
  lastLevelInches: 168,
  lastLevelAgeHours: 1,
  estInches: 168,
  remainingInches: 0,
  ttpHours: 0,
  gainValid: true,
  fresh: true,
  estFeet: 14,
  estDisplay: '14\'',
  readyFeet: 10,
  hasFlow: true,
  availableLoads: 1,
});

test('compareQueueRows: physical readiness strictly governs before assignment', () => {
  const rowUrgentAssigned: QueueRowItem = {
    well: baseWell('Gabriel 5'),
    priority: basePriority('pull-now', 1000),
    assignment: { state: 'assigned_not_started', driver: 'Mike ZFold7 Burger' },
  };

  const rowLessUrgentUnassigned: QueueRowItem = {
    well: baseWell('Gabriel 2'),
    priority: basePriority('pull-now', 2000),
    assignment: null,
  };

  // Even though Gabriel 5 is assigned, its readiness time (1000) is earlier than Gabriel 2 (2000).
  // Urgent assigned well MUST sort before less urgent unassigned well.
  assert.ok(compareQueueRows(rowUrgentAssigned, rowLessUrgentUnassigned) < 0,
    'Urgent assigned well must sort ahead of less-urgent unassigned well');
});

test('compareQueueRows: unassigned is deterministic tie-breaker when readiness time is identical', () => {
  const rowUnassigned: QueueRowItem = {
    well: baseWell('Gabriel B'),
    priority: basePriority('pull-now', 5000),
    assignment: null,
  };

  const rowAssigned: QueueRowItem = {
    well: baseWell('Gabriel A'), // alphabetically earlier, but assigned
    priority: basePriority('pull-now', 5000), // identical readiness time
    assignment: { state: 'assigned_not_started', driver: 'Mike ZFold7 Burger' },
  };

  // Identical readiness times (5000) -> unassigned tie-breaker wins ahead of alphabetical
  assert.ok(compareQueueRows(rowUnassigned, rowAssigned) < 0,
    'Unassigned well must sort ahead of assigned well when exact readiness time is identical');
  assert.ok(compareQueueRows(rowAssigned, rowUnassigned) > 0,
    'Assigned well must sort behind unassigned well when exact readiness time is identical');
});

test('source contract: page.tsx visually separates Priority and Coverage columns', () => {
  const pagePath = fileURLToPath(new URL('../../app/dispatch/page.tsx', import.meta.url));
  const page = readFileSync(pagePath, 'utf8');

  // Dedicated headers for Priority and Coverage
  assert.match(page, /<th[^>]*>Priority<\/th>/);
  assert.match(page, /<th[^>]*>Coverage<\/th>/);

  // Priority column renders pure physical badge without ASSIGNED chip
  assert.match(page, /\{priority\.label\}<\/span>/);

  // Coverage column renders UNASSIGNED or ASSIGNED — {driver}
  assert.match(page, /UNASSIGNED/);
  assert.match(page, /ASSIGNED —/);

  // Real display name is NOT truncated with .split(' ')[0]
  assert.ok(!/rd\s*\?\s*\(rd\.legalName\s*\|\|\s*rd\.displayName\s*\|\|\s*'Driver'\)\.split\(' '\)\[0\]/.test(page),
    'driver name must not be truncated to first name only in attribution');
});

test('source contract: page.tsx renders always-visible View affordance on assigned rows', () => {
  const pagePath = fileURLToPath(new URL('../../app/dispatch/page.tsx', import.meta.url));
  const page = readFileSync(pagePath, 'utf8');

  // Both navigable View button and disabled fallback View button exist so affordance is always visible
  assert.match(page, /router\.push\(wbmHref\)/);
  assert.match(page, /disabled=\{true\}|disabled\b[^>]*aria-disabled="true"/);
  assert.match(page, /Well detail unavailable/);
});
