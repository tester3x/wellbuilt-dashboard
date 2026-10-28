import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshWaterMinimumForecast } from '../freshWaterMinimumForecast';
import type { WellResponse } from '../wellPoolCore';

const well = (overrides: Partial<WellResponse>): WellResponse => ({
  wellName: 'Gabriel FW', currentLevel: '--', etaToMax: '', flowRate: '', timestamp: '',
  routeType: 'freshwater', bottomLevel: 8, tankHeight: 20, ...overrides,
});

test('Gabriel 2 reaches its 8 ft delivery minimum from the measured baseline', () => {
  const start = Date.parse('2026-10-27T22:45:00Z');
  const forecast = freshWaterMinimumForecast(well({ bblPerFoot: 20, inventoryDailyBbl: 15 }), 13.5, start);
  assert.equal(forecast?.at, '2026-11-04T06:45:00.000Z');
  assert.equal(forecast?.hoursRemaining, 176);
});

test('Gabriel 3/7 uses the two equalized tanks and total daily consumption', () => {
  const start = Date.parse('2026-10-27T23:30:00Z');
  const forecast = freshWaterMinimumForecast(well({ bblPerFoot: 40, inventoryDailyBbl: 30 }), 14.5, start);
  assert.equal(forecast?.at, '2026-11-05T15:30:00.000Z');
  assert.equal(forecast?.hoursRemaining, 208);
});

test('unknown minimum, unknown rate, and produced-water rows have no freshwater forecast', () => {
  const now = Date.parse('2026-10-27T23:30:00Z');
  assert.equal(freshWaterMinimumForecast(well({ bottomLevel: undefined, bblPerFoot: 40, inventoryDailyBbl: 30 }), 14.5, now), null);
  assert.equal(freshWaterMinimumForecast(well({ bblPerFoot: 40, inventoryDailyBbl: null }), 14.5, now), null);
  assert.equal(freshWaterMinimumForecast(well({ routeType: 'produced-water', bblPerFoot: 40, inventoryDailyBbl: 30 }), 14.5, now), null);
});
