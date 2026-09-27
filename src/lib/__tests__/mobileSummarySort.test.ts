import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WellResponse } from '../wellPoolCore.ts';
import { DEFAULT_SUMMARY_SORT, sortMobileSummaryWells, type SummarySortField } from '../mobileSummarySort.ts';

const NOW = Date.parse('2026-09-27T03:00:00Z');
function well(name: string, level: string, flow = '3:00:00', extra: Partial<WellResponse> = {}): WellResponse {
  return {
    wellName: name, currentLevel: level, lastPullBottomLevel: level,
    lastPullDateTimeUTC: new Date(NOW).toISOString(), timestamp: '', flowRate: flow,
    etaToMax: '--', tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 140, ...extra,
  };
}
const names = (rows: WellResponse[]) => rows.map(w => w.wellName);

test('Gabriels: ready and soonest pulls first; down wells last by descending frozen level', () => {
  const rows = [
    well('Gabriel 1', "5'5\"", '12:34:14', { isDown: true }),
    well('Gabriel 2', "6'7\"", '9:07:56'),
    well('Gabriel 3', "8'5\"", '11:34:33'),
    well('Gabriel 4', "7'5\"", '5:01:21'),
    well('Gabriel 5', "11'2\"", '3:00:14'),
    well('Gabriel 6', "9'11\"", '4:55:28'),
    well('Gabriel 7', "5'4\"", '3:36:47'),
    well('Thor 1', "2'6\"", '12:10:39', { wellDown: true }),
    well('Thor 5', "10'5\"", '2:43:45', { isDown: true, tanks: 6, bblPerFoot: 120 }),
  ];
  const original = names(rows);
  assert.deepEqual(names(sortMobileSummaryWells(rows, DEFAULT_SUMMARY_SORT, NOW)), [
    'Gabriel 5', 'Gabriel 6', 'Gabriel 4', 'Gabriel 7', 'Gabriel 3', 'Gabriel 2',
    'Thor 5', 'Gabriel 1', 'Thor 1',
  ]);
  assert.deepEqual(names(rows), original);
});

test('every column and direction retains the down section at the bottom', () => {
  const rows = [well('Down low', "2'", '--', { isDown: true }), well('Up', "8'"),
    well('Down high', "11'", '0:01:00', { currentLevel: 'offline' })];
  const fields: SummarySortField[] = ['wellName', 'tanks', 'nextPull', 'level', 'flowRate', 'timeTillPull', 'status'];
  for (const field of fields) for (const dir of ['asc', 'desc'] as const) {
    assert.deepEqual(names(sortMobileSummaryWells(rows, { field, dir }, NOW + 86400000)),
      ['Up', 'Down high', 'Down low'], `${field} ${dir}`);
  }
});

test('changing the load slider changes readiness order using each well capacity', () => {
  const rows = [well('Fast single tank', "10'6\"", '0:10:00'),
    well('Slow two tanks', "7'", '1:00:00', { tanks: 2, bblPerFoot: 40 })];
  assert.deepEqual(names(sortMobileSummaryWells(rows, DEFAULT_SUMMARY_SORT, NOW)),
    ['Slow two tanks', 'Fast single tank']);
  assert.deepEqual(names(sortMobileSummaryWells(rows.map(w => ({ ...w, pullBbls: 300 })), DEFAULT_SUMMARY_SORT, NOW)),
    ['Fast single tank', 'Slow two tanks']);
});

test('unknown baseline never becomes ready from stale Ready text or an old deadline', () => {
  const unknown = well('Unknown', "19'", '1:00:00', {
    lastPullBottomLevel: undefined, timeTillPull: 'Ready', nextPullTime: '2000-01-01',
  });
  const readyNoFlow = well('Stored water', "12'", '--');
  const forecast = well('Upcoming', "8'", '1:00:00');
  assert.deepEqual(names(sortMobileSummaryWells([unknown, forecast, readyNoFlow], DEFAULT_SUMMARY_SORT, NOW)),
    ['Stored water', 'Upcoming', 'Unknown']);
});

test('Next Pull remains selectable and invalid dates stay after valid operating wells', () => {
  const rows = [well('Missing date', "8'", '1:00:00', { nextPullTime: 'invalid' }),
    well('Later', "8'", '1:00:00', { nextPullTimeUTC: '2026-09-28T00:00:00Z' }),
    well('Earlier', "8'", '1:00:00', { nextPullTimeUTC: '2026-09-27T00:00:00Z' })];
  assert.deepEqual(names(sortMobileSummaryWells(rows, { field: 'nextPull', dir: 'asc' }, NOW)),
    ['Earlier', 'Later', 'Missing date']);
  assert.deepEqual(names(sortMobileSummaryWells(rows, { field: 'nextPull', dir: 'desc' }, NOW)),
    ['Later', 'Earlier', 'Missing date']);
});
