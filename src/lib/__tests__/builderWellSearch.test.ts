import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinedLocationResults, hasExactLocationMatch, operatorForBuilderWell, wellsForBuilderOperator, COMBINED_SEARCH_LIMIT } from '../builderWellSearch.ts';

const sources = {
  wells: [
    { ndicName: 'GABRIEL 5-36-25TFH', wellName: 'Gabriel 5', route: 'Route A' },
    { wellName: 'Thor 1', route: 'Route B' },
  ],
  operatorWells: [
    { well_name: 'Gabriel 5', operator: 'Liquid Gold' }, // duplicate of a pool well (by name) → deduped
    { well_name: 'Hess Federal 12', operator: 'Hess' },
  ],
  disposalMatches: [{ well_name: 'Stateline SWD' }],
};

test('under two characters returns nothing', () => {
  assert.deepEqual(combinedLocationResults('g', sources), []);
  assert.deepEqual(combinedLocationResults(' ', sources), []);
});

test('merges wells → operator wells → disposals, order preserved', () => {
  const tiered = {
    wells: [{ wellName: 'Alpha zz', route: 'R' }],
    operatorWells: [{ well_name: 'Beta zz', operator: 'Op' }],
    disposalMatches: [{ well_name: 'Gamma zz' }],
  };
  const r = combinedLocationResults('zz', tiered).map((x) => x.label);
  assert.deepEqual(r, ['Alpha zz', 'Beta zz', 'Gamma zz'], 'wells before operator wells before disposals');
});

test('de-duplicates an IDENTICAL name appearing in more than one source', () => {
  const dup = {
    wells: [{ wellName: 'Thor 1', route: 'B' }],
    operatorWells: [{ well_name: 'Thor 1', operator: 'Op' }], // identical name → deduped
    disposalMatches: [{ well_name: 'Thor 1' }], // identical name → deduped
  };
  const r = combinedLocationResults('thor', dup);
  assert.equal(r.length, 1, 'the identical name appears exactly once (pool well wins)');
  assert.equal(r[0].value, 'Thor 1');
});

test('an exact match shows no list (the field already holds that value)', () => {
  assert.equal(hasExactLocationMatch('Thor 1', sources), true);
  assert.deepEqual(combinedLocationResults('Thor 1', sources), []);
});

test('results are bounded to the search limit', () => {
  const many = { wells: Array.from({ length: 50 }, (_, i) => ({ wellName: `Well ${i}`, route: 'R' })), operatorWells: [], disposalMatches: [] };
  assert.equal(combinedLocationResults('well', many).length, COMBINED_SEARCH_LIMIT);
});

test('disposal sub-label is SWD; operator sub falls back to NDIC', () => {
  const r = combinedLocationResults('hess federal', sources);
  assert.equal(r[0].sub, 'Hess');
  const d = combinedLocationResults('stateline', sources);
  assert.equal(d[0].sub, 'SWD');
});

test('builder operator uses only the selected well, not a similarly named production well', () => {
  const wells = [
    { well_name: 'Gab 1', operator: 'WB Test Customer' },
    { well_name: 'Gabriel 1', operator: 'SLAWSON EXPLORATION COMPANY, INC.' },
  ];
  assert.equal(operatorForBuilderWell('Gab 1', wells), 'WB Test Customer');
  assert.equal(operatorForBuilderWell('Gabriel 1', wells), 'SLAWSON EXPLORATION COMPANY, INC.');
  assert.equal(operatorForBuilderWell('Gab', wells), '');
});

test('selected operator excludes other customers from pickup searches', () => {
  const operatorWells = [
    { well_name: 'Gab 1', operator: 'WB Test Customer' },
    { well_name: 'Gabriel 1', operator: 'SLAWSON EXPLORATION COMPANY, INC.' },
  ];
  const pool = [{ wellName: 'Gab 1' }, { wellName: 'Gabriel 1' }];
  assert.deepEqual(wellsForBuilderOperator(pool, operatorWells, 'WB Test Customer'), [pool[0]]);
  const results = combinedLocationResults('gab', {
    wells: wellsForBuilderOperator(pool, operatorWells, 'WB Test Customer'),
    operatorWells: operatorWells.filter(w => w.operator === 'WB Test Customer'),
    disposalMatches: [],
  });
  assert.deepEqual(results.map(result => result.value), ['Gab 1']);
});
