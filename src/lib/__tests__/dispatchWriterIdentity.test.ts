import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentIdentityForDriver,
  dispatchCreateTargetForAssignment,
  dispatchCreateTargetForDriver,
  driverRealName,
  isCanonicalDriverId,
} from '../dispatchWriterIdentity.ts';
import type { DriverIdentity } from '../dispatchDriverIdentity.ts';
import { buildCreatePayload } from '../staffWriteDispatchCore.ts';

const CANON = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const LEGACY_HASH = 'a'.repeat(64);

// The real field reality: the profile's displayName is literally the login "Mikezfold";
// the real human name lives in legalName "Mike ZFold7 Burger".
const mike: DriverIdentity = {
  key: CANON,
  driverId: CANON,
  companyId: 'liquid-gold',
  displayName: 'Mikezfold',
  legalName: 'Mike ZFold7 Burger',
};

test('isCanonicalDriverId: UUID yes, passcode hash no', () => {
  assert.equal(isCanonicalDriverId(CANON), true);
  assert.equal(isCanonicalDriverId(LEGACY_HASH), false);
  assert.equal(isCanonicalDriverId(''), false);
  assert.equal(isCanonicalDriverId(undefined), false);
});

test('driverRealName prefers legalName over displayName (login)', () => {
  assert.equal(driverRealName(mike), 'Mike ZFold7 Burger');
  assert.equal(driverRealName({ displayName: 'Real Name', legalName: '' }), 'Real Name');
  assert.equal(driverRealName({ displayName: '', legalName: '' }), '');
});

test('assignmentIdentityForDriver stamps canonical driverId + driverHash + REAL name (never login)', () => {
  const id = assignmentIdentityForDriver(mike);
  assert.equal(id.driverId, CANON);
  assert.equal(id.driverHash, CANON);                 // canonical UUID as compat value
  assert.equal(id.driverName, 'Mike ZFold7 Burger');  // legalName, the real name
  assert.notEqual(id.driverName, 'Mikezfold');        // NEVER the login
});

test('canonical id comes from the record key when it is a UUID and driverId is absent', () => {
  const d: DriverIdentity = { key: CANON, companyId: 'liquid-gold', displayName: 'Mikezfold', legalName: 'Mike ZFold7 Burger' };
  const id = assignmentIdentityForDriver(d);
  assert.equal(id.driverId, CANON);
  assert.equal(id.driverHash, CANON);
});

test('legacy-hash-keyed driver (no canonical UUID) keeps the key as compat hash, no driverId', () => {
  const legacy: DriverIdentity = { key: LEGACY_HASH, companyId: 'liquid-gold', displayName: 'LegacyGuy', legalName: 'Legacy Guy' };
  const id = assignmentIdentityForDriver(legacy);
  assert.equal(id.driverId, undefined);               // no canonical id to stamp
  assert.equal(id.driverHash, LEGACY_HASH);           // compat fallback
  assert.equal(id.driverName, 'Legacy Guy');          // still the real name, never a login
});

test('a passcode-hash record key is NEVER promoted to the canonical driverId', () => {
  const d: DriverIdentity = { key: LEGACY_HASH, driverId: LEGACY_HASH, companyId: 'x', displayName: 'z' };
  const id = assignmentIdentityForDriver(d);
  assert.equal(id.driverId, undefined);
  assert.equal(id.driverHash, LEGACY_HASH);
});

test('PW create resolves the selected driver company for a platform admin and preserves it on the wire', () => {
  const assignment = assignmentIdentityForDriver(mike);
  const target = dispatchCreateTargetForAssignment(true, assignment, [
    { key: 'other-uuid', companyId: 'other-company', displayName: 'Other' }, mike,
  ]);
  assert.deepEqual(target, { companyId: 'liquid-gold' });
  const payload = buildCreatePayload({ ...assignment, ...target, wellName: 'Gabriel 2', jobType: 'pw' });
  assert.equal((payload.record as Record<string, unknown>).companyId, 'liquid-gold');
  assert.deepEqual(dispatchCreateTargetForAssignment(false, assignment, []), {});
  assert.throws(() => dispatchCreateTargetForAssignment(true, assignment, []), /missing from the driver list/);
  assert.throws(() => dispatchCreateTargetForDriver(true, { companyId: '' }), /Selected driver has no company/);
});
