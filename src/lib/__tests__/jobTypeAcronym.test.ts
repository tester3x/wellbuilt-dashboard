import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobTypeAcronym, jobTypeCode, JOB_TYPE_ACRONYMS } from '../jobTypeAcronym.ts';

// The two canonical dispatch job types (the only values DispatchJob.jobType stores).
const SUPPORTED_DISPATCH_TYPES = ['pw', 'service'] as const;

test('every supported dispatch job type maps to a canonical two-letter acronym + full name', () => {
  assert.deepEqual(jobTypeAcronym('pw'), { code: 'PW', full: 'Produced Water' });
  assert.deepEqual(jobTypeAcronym('service'), { code: 'SW', full: 'Service Work' });
  for (const t of SUPPORTED_DISPATCH_TYPES) {
    const info = jobTypeAcronym(t);
    assert.equal(info.code.length, 2, `${t} → exactly two letters`);
    assert.ok(info.full.length > 2, `${t} → a full descriptive name is preserved`);
  }
});

test('recognized related tokens map canonically (PW / SW / DW / FW)', () => {
  assert.equal(jobTypeCode('pw'), 'PW');
  assert.equal(jobTypeCode('service'), 'SW');
  assert.equal(jobTypeCode('sw'), 'SW');
  assert.equal(jobTypeCode('dw'), 'DW');
  assert.equal(jobTypeCode('fw'), 'FW');
  assert.equal(jobTypeAcronym('dw').full, 'Disposal Water');
  assert.equal(jobTypeAcronym('fw').full, 'Fresh Water');
});

test('every entry in the explicit mapping is a two-letter code with a full name (audit)', () => {
  for (const [key, info] of Object.entries(JOB_TYPE_ACRONYMS)) {
    assert.equal(info.code.length, 2, `${key} code is two letters`);
    assert.equal(info.code, info.code.toUpperCase(), `${key} code is uppercase`);
    assert.ok(info.full.trim().length > 0, `${key} has a full name`);
  }
});

test('resolution is case-insensitive and whitespace-tolerant (stored value never altered)', () => {
  assert.equal(jobTypeCode(' PW '), 'PW');
  assert.equal(jobTypeCode('Service'), 'SW');
  assert.equal(jobTypeCode('SERVICE'), 'SW');
});

test('an unrecognized token still renders two letters and preserves the original as the full name', () => {
  const info = jobTypeAcronym('brine');
  assert.equal(info.code, 'BR');
  assert.equal(info.full, 'brine');
  // Null / empty are safe.
  assert.deepEqual(jobTypeAcronym(''), { code: '??', full: 'Unknown' });
  assert.deepEqual(jobTypeAcronym(null), { code: '??', full: 'Unknown' });
  assert.deepEqual(jobTypeAcronym(undefined), { code: '??', full: 'Unknown' });
});
