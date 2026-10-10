import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTimestampToDate } from '../dispatchTimestampToDate.ts';

const iso = '2026-10-09T12:34:56.000Z';
const ms = Date.parse(iso);

test('completed dispatches written by WB Tickets use epoch milliseconds', () => {
  assert.equal(dispatchTimestampToDate(ms)?.toISOString(), iso);
});

test('completed dispatches written with Firestore and ISO timestamps still parse', () => {
  assert.equal(dispatchTimestampToDate({ toDate: () => new Date(ms) })?.toISOString(), iso);
  assert.equal(dispatchTimestampToDate({ seconds: ms / 1000 })?.toISOString(), iso);
  assert.equal(dispatchTimestampToDate(iso)?.toISOString(), iso);
});

test('missing or invalid completion dates do not pass a range filter', () => {
  for (const value of [null, undefined, '', Number.NaN, 'not a date', {}]) {
    assert.equal(dispatchTimestampToDate(value), null);
  }
});
