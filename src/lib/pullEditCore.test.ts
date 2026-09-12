/**
 * Focused tests for the governed Dashboard pull-edit core (no firebase, no DOM).
 * Run: node --test --experimental-strip-types src/lib/pullEditCore.test.ts
 *
 * Covers the regression scenario and required cases: the edit targets the
 * original packet only, mints no new pull, is deterministic under double-submit,
 * and every failure class maps to a clear, sanitized operator message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminPullEditRequest, describeEditError } from './pullEditCore.ts';

const ORIG = '20260911_213623_Cyclone2_fbxyqp'; // the accepted original from the incident

test('successful edit: payload targets the original packet and mints NO new pull', () => {
  // Regression scenario: top 117in -> 104in, bbls stay 165, time unchanged.
  const req = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  assert.equal(req.originalPacketId, ORIG);       // addressed only by original id
  assert.equal(req.wellName, 'Cyclone 2');
  assert.equal(req.tankTopInches, 104);
  assert.equal(req.bblsTaken, 165);
  assert.equal(req.wellDown, false);
  assert.ok(!('newDateTimeUTC' in req));          // time unchanged -> omitted
  // No new-pull / client-minted fields may ever be present:
  for (const forbidden of ['packetId', 'requestType', 'timestamp', 'source', 'dateTimeUTC']) {
    assert.ok(!(forbidden in req), `payload must not contain ${forbidden}`);
  }
});

test('operational timestamp preserved as-is when unchanged (no time key sent)', () => {
  const req = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  assert.equal(req.newDateTimeUTC, undefined);
});

test('changed time is forwarded verbatim under newDateTimeUTC', () => {
  const req = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, '2026-09-12T02:26:00.000Z', false);
  assert.equal(req.newDateTimeUTC, '2026-09-12T02:26:00.000Z');
});

test('double-submit / retry is deterministic: identical inputs -> identical request, same original target', () => {
  const a = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  const b = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  assert.deepEqual(a, b);                          // no time-based / random id -> idempotent target
  assert.equal(a.originalPacketId, b.originalPacketId);
});

test('wellDown authority: only explicit true sets it', () => {
  assert.equal(buildAdminPullEditRequest(ORIG, 'W', 1, 1, undefined, true).wellDown, true);
  assert.equal(buildAdminPullEditRequest(ORIG, 'W', 1, 1, undefined, undefined).wellDown, false);
});

// ── error mapping (validation / auth / callable / network) ───────────────────

test('validation failures map to specific, sanitized guidance', () => {
  assert.match(describeEditError({ code: 'invalid-argument', message: 'tankTopInches_invalid' }), /tank level/i);
  assert.match(describeEditError({ code: 'invalid-argument', message: 'bblsTaken_invalid' }), /barrels/i);
  assert.match(describeEditError({ code: 'invalid-argument', message: 'newDateTimeUTC_invalid' }), /date\/time/i);
  assert.match(describeEditError({ code: 'invalid-argument', message: 'originalPacketId_required' }), /identified|refresh/i);
});

test('prefixed transport message ("code: reason") still resolves the reason', () => {
  assert.match(describeEditError({ code: 'invalid-argument', message: 'invalid-argument: bblsTaken_invalid' }), /barrels/i);
});

test('auth / permission failures map to permission guidance', () => {
  assert.match(describeEditError({ code: 'unauthenticated', message: 'x' }), /session expired/i);
  assert.match(describeEditError({ code: 'permission-denied', message: 'well_outside_company' }), /permission/i);
  assert.match(describeEditError({ code: 'permission-denied', message: 'manageDrivers_required' }), /permission/i);
});

test('network / service failures state the pull was NOT changed', () => {
  for (const code of ['unavailable', 'internal', 'deadline-exceeded']) {
    const msg = describeEditError({ code, message: 'boom' });
    assert.match(msg, /NOT changed/i);
  }
});

test('unknown error never leaks raw text and states no change occurred', () => {
  const msg = describeEditError(new Error('TypeError: undefined is not a function at line 42'));
  assert.ok(!msg.includes('undefined is not a function'));
  assert.match(msg, /NOT changed/i);
});

test('null / undefined error is handled safely', () => {
  assert.match(describeEditError(undefined), /NOT changed/i);
  assert.match(describeEditError(null), /NOT changed/i);
});
