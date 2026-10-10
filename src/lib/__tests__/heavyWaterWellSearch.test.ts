import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heavyWaterWellResults, type WeightedWellCandidate } from '../heavyWaterWellSearch';

const well = (wellName: string, waterWeight: number | undefined, estimatedFeet: number): WeightedWellCandidate => ({
  wellName,
  waterWeight,
  tankHeight: 20,
  estimatedFeet,
  estimatedLevel: `${estimatedFeet}'`,
});

test('10+ wells sort by level before 9.9 wells, then each lower weight band by level', () => {
  const wells = [
    well('unknown', undefined, 20),
    well('9.9 low', 9.91, 4),
    well('10 low', 10.5, 5),
    well('9.8 high', 9.81, 19),
    well('10 high', 10.0, 12),
    well('9.9 high', 9.98, 11),
  ];
  const rows = heavyWaterWellResults('', wells, []);
  assert.deepEqual(rows.map(row => row.label), ['10 high', '10 low', '9.9 high', '9.9 low', '9.8 high', 'unknown']);
  assert.equal(rows[0].waterWeight, 10);
  assert.equal(rows[0].tankHeight, 20);
  assert.equal(rows[0].estimatedLevel, "12'");
  assert.equal(rows[5].waterWeight, undefined);
});

test('typing filters the weighted list while leaving a selected exact well alone', () => {
  const wells = [well('Gabriel 1', 10, 8), well('Thor 1', 9.9, 12)];
  assert.deepEqual(heavyWaterWellResults('gab', wells, []).map(row => row.value), ['Gabriel 1']);
  assert.deepEqual(heavyWaterWellResults('Gabriel 1', wells, []), []);
});
