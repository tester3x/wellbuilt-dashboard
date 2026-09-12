const assert = require('node:assert/strict');
const admin = require('firebase-admin');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  throw new Error('Both emulators are required; refusing production execution');
}
const projectId = 'demo-dvir-completion';
admin.initializeApp({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
const api = require('../lib/security/operational/dvirCompletionCallables');
const fs = admin.firestore();
const rtdb = admin.database();
const old = '2026-08-23_232617';
const current = '2026-09-12_110729';
const owner = { expectedDriverId: 'driver-a', expectedCompanyId: 'company-a' };
function request(data, driver = 'driver-a', app = 'equipment') {
  return { data, auth: { uid: `uid-${driver}`, token: { kind: 'driver', driverId: driver, companyId: 'company-a', app } } };
}
async function denied(call, code) { await assert.rejects(call, e => e.code === code); }
(async () => {
  for (const driverId of ['driver-a', 'driver-b']) {
    await fs.doc(`driver_credentials/${driverId}`).set({ active: true });
    await rtdb.ref(`drivers/profiles/${driverId}`).set({ active: true, companyId: 'company-a' });
    await fs.doc(`driver_shift_authority/${driverId}`).set({ driverId, companyId: 'company-a',
      initialized: true, openPeriodId: current, lastClosedPeriodId: old, version: 9 });
  }
  const authorityBefore = (await fs.doc('driver_shift_authority/driver-a').get()).data();
  const pre = { ...owner, shiftId: old, inspectionId: 'inspection-old', phase: 'pre_trip',
    completedAt: '2026-08-23T23:30:00.000Z', reportDigest: 'a'.repeat(64) };
  await denied(api.recordDriverDvirCompletion.run({ data: pre }), 'unauthenticated');
  await denied(api.recordDriverDvirCompletion.run(request(pre, 'driver-a', 'suite')), 'permission-denied');
  await denied(api.recordDriverDvirCompletion.run(request(pre, 'driver-b')), 'permission-denied');
  await denied(api.recordDriverDvirCompletion.run(request({ ...pre, shiftId: '2025-01-01_120000' })), 'permission-denied');
  const first = await api.recordDriverDvirCompletion.run(request(pre));
  assert.equal(first.created, true);
  const duplicate = await api.recordDriverDvirCompletion.run(request(pre));
  assert.equal(duplicate.created, false);
  await denied(api.recordDriverDvirCompletion.run(request({ ...pre, reportDigest: 'b'.repeat(64) })), 'already-exists');
  const next = await api.resolveEquipmentDvirEntry.run(request({ ...owner, shiftId: current, phase: 'pre_trip' }));
  assert.deepEqual(next.binding, { shiftId: old, phase: 'post_trip' });
  const other = await api.resolveEquipmentDvirEntry.run(request({ ...owner,
    expectedDriverId: 'driver-b', shiftId: current, phase: 'pre_trip' }, 'driver-b'));
  assert.deepEqual(other.binding, { shiftId: current, phase: 'pre_trip' });
  const status = await api.resolveDriverDvirStatus.run(request({ ...owner, shiftId: old }, 'driver-a', 'suite'));
  assert.equal(status.preTrip.inspectionId, pre.inspectionId);
  const post = { ...pre, phase: 'post_trip', completedAt: new Date().toISOString(), reportDigest: 'c'.repeat(64) };
  await api.recordDriverDvirCompletion.run(request(post));
  const resumed = await api.resolveEquipmentDvirEntry.run(request({ ...owner, shiftId: current, phase: 'pre_trip' }));
  assert.deepEqual(resumed.binding, { shiftId: current, phase: 'pre_trip' });
  assert.deepEqual((await fs.doc('driver_shift_authority/driver-a').get()).data(), authorityBefore);
  await api.registerDriverDvirPostTrip.run(request({ ...owner, shiftId: current }));
  const draft = await api.resolveDriverDvirStatus.run(request({ ...owner, shiftId: current }, 'driver-a', 'suite'));
  assert.equal(draft.preTrip, null);
  assert.equal(draft.postTrip, null);
  assert.equal(draft.postTripPending, true);
  const legacyShift = '2026-07-01_120000';
  await api.registerDriverDvirPostTrip.run(request({ ...owner, shiftId: legacyShift }));
  const legacy = await api.resolveDriverDvirStatus.run(request({ ...owner, shiftId: legacyShift }, 'driver-a', 'suite'));
  assert.equal(legacy.origin, 'legacy_local_recovery');
  assert.equal(legacy.preTrip, null);
  assert.equal(legacy.postTrip, null);
  await denied(api.registerDriverDvirPostTrip.run(request({ ...owner, shiftId: '2027-01-01_120000' })), 'permission-denied');
  assert.deepEqual((await fs.doc('driver_shift_authority/driver-a').get()).data(), authorityBefore);
  await rtdb.ref('drivers/profiles/driver-a/active').set(false);
  await denied(api.resolveDriverDvirStatus.run(request({ ...owner, shiftId: current })), 'permission-denied');
  console.log('DVIR callable emulator checks passed: auth, ownership, historical recovery, immutable retries, cross-account isolation, no shift closure, draft registration, revocation.');
  await Promise.all(admin.apps.map(app => app.delete()));
})().catch(e => { console.error(e); process.exit(1); });
