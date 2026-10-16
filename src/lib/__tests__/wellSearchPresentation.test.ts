import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchWellStatus, rankWellSearchRows } from '../wellSearchPresentation.ts';
import type { WellResponse } from '../wellPoolCore.ts';

const now = Date.UTC(2026, 0, 1, 12);
const well = (wellName: string, extra: Partial<WellResponse> = {}): WellResponse => ({
  wellName, currentLevel: "8'", lastPullBottomLevel: "8'", flowRate: '1:00:00',
  lastPullDateTimeUTC: new Date(now).toISOString(), timestamp: new Date(now).toISOString(),
  tanks: 1, bottomLevel: 0, ...extra,
});

test('search shares queue urgency, exact aliases and DOWN freeze', () => {
  const status = buildSearchWellStatus([
    well('Z urgent', { ndicName: 'Z URGENT FULL', lastPullBottomLevel: "15'" }),
    well('A later', { lastPullBottomLevel: "2'" }),
    well('B down', { wellDown: true }),
  ], now + 3600000);
  assert.deepEqual(status.get('z urgent full'), status.get('z urgent'));
  assert.match(status.get('b down')!.level, /^DOWN/);
  assert.equal(status.get('unmaintained'), undefined);
  const rows = ['A later', 'Z URGENT FULL', 'Unmaintained', 'B down'].map(name => ({ name }));
  assert.deepEqual(rankWellSearchRows(rows, '', r => r.name, status).map(r => r.name),
    ['Z URGENT FULL', 'A later', 'B down', 'Unmaintained']);
  assert.equal(rankWellSearchRows(rows, 'a later', r => r.name, status)[0], rows[0]);
});

test('cap follows ranking; unknown, custom and ambiguous rows never borrow status', () => {
  const status = buildSearchWellStatus([well('Z urgent'), well('Twin', { ndicName: 'Shared' }), well('Other', { ndicName: 'Shared' })], now);
  assert.equal(status.get('shared'), undefined);
  const rows = [{ name: 'A catalog', kind: 'WELL' }, { name: 'Z urgent', kind: 'LOC' }, { name: 'Z urgent', kind: 'WELL' }];
  assert.equal(rankWellSearchRows(rows, '', r => r.name, status, 1, r => r.kind === 'WELL')[0], rows[2]);
  assert.deepEqual(rows.map(r => r.name), ['A catalog', 'Z urgent', 'Z urgent']);
});
