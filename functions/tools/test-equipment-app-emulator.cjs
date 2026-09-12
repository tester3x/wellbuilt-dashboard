const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  throw new Error('Refusing production: Firestore and RTDB emulators are required');
}
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-dvir-completion', databaseURL: 'https://demo-dvir-completion-default-rtdb.firebaseio.com' });
const { buildSsoDeps } = require('../lib/sso/ssoCallables');
const { issueEquipmentAppAccess, exchangeEquipmentAppAccess } = require('../lib/sso/equipmentAppAccess');
const { WELLBUILT_APP_EQUIPMENT } = require('@tester3x/wellbuilt-contracts');
(async () => {
  const deps = buildSsoDeps();
  let minted = 0;
  deps.getDriver = async () => ({ driverId: 'd', companyId: 'c', active: true, displayName: 'Test' });
  deps.getCompanyContract = async () => ({ state: 'active', contract: { planId: 'p', contractEnforced: true } });
  deps.getPlan = async () => ({ contractVersion: 1, planId: 'p', displayName: 'P', capabilities: [], status: 'active',
    apps: { [WELLBUILT_APP_EQUIPMENT]: { included: true, requiresActiveShift: true } } });
  deps.mintCustomToken = async () => { minted++; return 'emulator-only-token'; };
  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const issued = await issueEquipmentAppAccess(deps, { uid: 'uid-d', claims: { kind: 'driver', driverId: 'd', companyId: 'c' } },
    { version: 1, codeChallenge });
  const results = await Promise.allSettled([1, 2].map(() => exchangeEquipmentAppAccess(deps,
    { version: 1, code: issued.code, codeVerifier: verifier })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(minted, 1);
  const snap = await admin.firestore().doc('equipment_app_codes/' + deps.sha256Hex(issued.code)).get();
  assert.equal(snap.data().consumed, true);
  assert.equal(typeof snap.data().expiresAt.toMillis(), 'number');
  assert.equal((await admin.firestore().collection('driver_shift_authority').get()).size, 0);
  assert.equal((await admin.firestore().collection('driver_dvir_completions').get()).size, 0);
  console.log('Equipment app-access real Firestore transaction: one redemption/mint, consumed record, native Timestamp, zero shift/inspection writes PASS');
  await Promise.all(admin.apps.map(app => app.delete()));
})().catch(error => { console.error(error.message); process.exit(1); });
