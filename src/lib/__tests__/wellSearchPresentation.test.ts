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

test('flow and tank geometry determine the next load, ahead of name prefix and height', () => {
  const source = [
    well('Match high slow', { lastPullBottomLevel: "6'", flowRate: '10:00:00' }),
    well('Z Match low fast', { lastPullBottomLevel: "3'", flowRate: '0:10:00' }),
    well('B Match two tanks', { lastPullBottomLevel: "3'", flowRate: '0:10:00', tanks: 2 }),
  ];
  const status = buildSearchWellStatus(source, now);
  const rows = source.map(w => ({ name: w.wellName }));
  assert.deepEqual(rankWellSearchRows(rows, 'match', r => r.name, status).map(r => r.name),
    ['B Match two tanks', 'Z Match low fast', 'Match high slow']);
  assert.equal(rankWellSearchRows(rows, 'Match high slow', r => r.name, status)[0], rows[0]);
  const down = buildSearchWellStatus([well('A down low', { wellDown: true, lastPullBottomLevel: "3'" }), well('Z down high', { wellDown: true, lastPullBottomLevel: "8'" })], now);
  assert.ok(down.get('z down high')!.order < down.get('a down low')!.order);
});
