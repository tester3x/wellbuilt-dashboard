// DDJD ↔ Dashboard identity + Active-Jobs classification — the 10 required proofs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchMatchesDriver,
  resolveDispatchDriver,
  dispatchDriverDisplayName,
  dispatchDriverGroupKey,
  dispatchActiveJobState,
  dispatchVisibleOnDashboard,
  canonicalDriverIds,
  type DriverIdentity,
} from '../dispatchDriverIdentity.ts';

const CANON = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const LEGACY_HASH = '7413cd7d106a0f49c2a670064bc049e3260a522a09a6a5a7fad0c53522e63c27';
// Mikezfold: approved-record keyed by canonical UUID. The profile's displayName is
// literally the login ("Mikezfold"); the real human name lives in legalName.
const mike: DriverIdentity = { key: CANON, driverId: CANON, companyId: 'liquid-gold', displayName: 'Mikezfold', legalName: 'Mike ZFold7 Burger', legacyAliases: [LEGACY_HASH] };
const other: DriverIdentity = { key: 'other-uuid', driverId: 'other-uuid', companyId: 'acme', displayName: 'Al A' };
const drivers = [mike, other];

test('1. LG pending DDJD with canonical driverId → included in Active Jobs + attaches to driver', () => {
  const job = { driverId: CANON, companyId: 'liquid-gold', status: 'pending', driverName: 'Mikezfold' };
  assert.equal(dispatchActiveJobState(job.status), 'queued');          // included, not terminal
  assert.equal(resolveDispatchDriver(job, drivers)?.key, CANON);       // attaches to Mike
});

test('2. pending is an active (non-terminal) state — shows in Active Jobs (also stays assigned in Well Queue)', () => {
  assert.notEqual(dispatchActiveJobState('pending'), null);
});

test('3. starting keeps an Active Jobs card (in_progress non-terminal); Needs Pull removal is separate', () => {
  assert.equal(dispatchActiveJobState('in_progress'), 'in_progress');
});

test('4. canonical driverId attaches even when driverHash is obsolete/mismatched', () => {
  const job = { driverId: CANON, driverHash: 'STALE-OR-OBSOLETE-HASH', companyId: 'liquid-gold', status: 'pending' };
  assert.equal(dispatchMatchesDriver(job, mike), true);
  assert.equal(resolveDispatchDriver(job, drivers)?.key, CANON);
});

test('5. governed legacy-hash-only record resolves through the alias binding', () => {
  const job = { driverHash: LEGACY_HASH, companyId: 'liquid-gold', status: 'accepted' }; // no driverId
  assert.equal(dispatchMatchesDriver(job, mike), true);
  assert.equal(resolveDispatchDriver(job, drivers)?.key, CANON);
});

test('6. a legacy alias NEVER matches across companies', () => {
  const job = { driverHash: LEGACY_HASH, companyId: 'acme', status: 'pending' }; // same hash, wrong company
  assert.equal(dispatchMatchesDriver(job, mike), false);
  assert.equal(resolveDispatchDriver(job, drivers), null);
});

test('7. Review item is represented with a Review state', () => {
  assert.equal(dispatchActiveJobState('pending_approval'), 'review');
});

test('8. dismissed/completed/cancelled/declined leave the active surface', () => {
  for (const s of ['dismissed', 'completed', 'cancelled', 'declined']) {
    assert.equal(dispatchActiveJobState(s), null, s);
  }
});

test('9. display uses the REAL profile name, never the login/hash', () => {
  const job = { driverId: CANON, companyId: 'liquid-gold', driverName: 'Mikezfold' };
  const shown = dispatchDriverDisplayName(job, drivers);
  assert.equal(shown, 'Mike ZFold7 Burger');     // legalName — the real human name
  assert.notEqual(shown, 'Mikezfold');           // never the login (which is the profile displayName!)
  assert.notEqual(shown, CANON);                 // never the id/hash
  // unresolved → safe placeholder, still never the login
  const unresolved = dispatchDriverDisplayName({ driverHash: 'ghost', companyId: 'liquid-gold', driverName: 'Mikezfold' }, drivers);
  assert.equal(unresolved, 'Unassigned driver');
});

test('10. a company without Dispatch enabled stays phone-only (no Dashboard exposure)', () => {
  assert.equal(dispatchVisibleOnDashboard(false), false);
  assert.equal(dispatchVisibleOnDashboard(true), true);
});

// ── supporting guarantees ──
test('canonical driverId match is preferred over a legacy match', () => {
  // A dispatch with BOTH a canonical id (Mike) and a legacy hash bound elsewhere resolves to canonical.
  const job = { driverId: CANON, driverHash: LEGACY_HASH, companyId: 'liquid-gold' };
  assert.equal(resolveDispatchDriver(job, drivers)?.key, CANON);
  assert.deepEqual(canonicalDriverIds(mike), [CANON]);
});

test('grouping key is the canonical id, never a login/hash', () => {
  const job = { driverId: CANON, companyId: 'liquid-gold', driverName: 'Mikezfold' };
  assert.equal(dispatchDriverGroupKey(job, drivers), CANON);
  // unresolved groups under a stable non-login key
  assert.equal(dispatchDriverGroupKey({ driverHash: 'ghost', companyId: 'liquid-gold' }, drivers), 'unresolved:ghost');
});
