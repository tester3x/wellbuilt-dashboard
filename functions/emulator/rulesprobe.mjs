// Predeployment rules probe (safety gate item 1): CLIENT-SDK writes — never
// Admin SDK — against the ACTUAL DEPLOYED rules (fixtures/deployed-rules.json,
// a verbatim snapshot of /.settings/rules from production 2026-08-30) for
// every role. Proves an ordinary client cannot forge coordinator-owned state,
// and that the Admin SDK retains server access.
//
// RUN:
//   JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:\t' GCLOUD_PROJECT=wellbuilt-sync \
//   npx firebase emulators:exec --config firebase.rulesprobe.json \
//     --only database,auth --project wellbuilt-sync "node functions/emulator/rulesprobe.mjs"
import { initializeApp } from 'firebase/app';
import { getDatabase, ref as cref, set as cset, connectDatabaseEmulator } from 'firebase/database';
import { getAuth, signInWithCustomToken, connectAuthEmulator, signOut } from 'firebase/auth';
import adminPkg from 'firebase-admin';

const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const [dbHostName, dbPort] = DB_HOST.split(':');
const NS = `${PROJECT}-default-rtdb`;

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, databaseURL: `http://${DB_HOST}/?ns=${NS}` });
const admin = adminPkg.default ?? adminPkg;
admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${DB_HOST}/?ns=${NS}` });
const adb = admin.database();

// Client SDK app (separate from admin) → subject to rules.
const clientApp = initializeApp({ apiKey: 'fake', projectId: PROJECT, databaseURL: `http://${DB_HOST}/?ns=${NS}` });
const cdb = getDatabase(clientApp);
connectDatabaseEmulator(cdb, dbHostName, Number(dbPort));
const cauth = getAuth(clientApp);
connectAuthEmulator(cauth, `http://${AUTH_HOST}`, { disableWarnings: true });

let failures = 0;
const results = [];
const check = (name, cond, detail = '') => {
  if (cond) results.push(`  PASS  ${name}`);
  else { failures++; results.push(`  FAIL  ${name}  ${detail}`); }
};

async function tokenFor(uid, claims) {
  await admin.auth().createUser({ uid }).catch(() => {});
  await admin.auth().setCustomUserClaims(uid, claims);
  return admin.auth().createCustomToken(uid, claims);
}

/** Attempt a CLIENT write; return 'denied' | 'allowed' | 'error:<msg>'. */
async function clientWrite(path, value) {
  try {
    await cset(cref(cdb, path), value);
    return 'allowed';
  } catch (e) {
    const code = e?.code || String(e?.message || e);
    return /PERMISSION_DENIED|permission_denied|Permission denied/i.test(code) ? 'denied' : `error:${code}`;
  }
}

// Every coordinator-owned / evidence path a compromised client might target.
const PATHS = [
  ['wells/Gabriel 1/chronoReceipts/opX', { operationId: 'opX', forged: true }],
  ['wells/Gabriel 1/status/chronoLock', { token: 't', fence: 9, phase: 'committing', operationId: 'opX' }],
  ['wells/Gabriel 1/status/chronoRevision', 999],
  ['wells/Gabriel 1/status/isDown', true],
  ['packets/incoming_revision_v2', { v: 2, token: 'forged' }],
  ['packets/incoming_version', 1],
  ['packets/editReceipts/opX', { status: 'accepted' }],
  ['packets/processed/forged_pkt', { wellName: 'Gabriel 1', companyId: 'liquid-gold', bblsTaken: 999 }],
  ['packets/rejected/opX', null],                                  // delete evidence
  ['packets/incoming/forged_pkt', { requestType: 'pull', wellName: 'Gabriel 1', ingestedBy: 'driver_x', authSource: 'claims', payloadDigest: 'deadbeef' }],
  ['packets/outgoing/response_forged', { wellName: 'Gabriel 1' }],
  ['system/maintenance/wbmMutations', { paused: false }], // Blocker-3 gate flag — server-owned
];

async function probeRole(label, signIn) {
  if (signIn) await signIn(); else await signOut(cauth).catch(() => {});
  for (const [path, value] of PATHS) {
    const outcome = await clientWrite(path, value);
    check(`[${label}] cannot write ${path}`, outcome === 'denied', outcome);
  }
}

async function main() {
  // Seed one processed + rejected row via ADMIN so "delete evidence" / "modify
  // another company's packet" have real targets.
  await adb.ref('packets/processed/seed_pkt').set({ wellName: 'Gabriel 1', companyId: 'liquid-gold', bblsTaken: 140 });
  await adb.ref('packets/rejected/seed_rej').set({ wellName: 'Gabriel 1', reason: 'CORRECTION_CONFLICT', packet: { bblsTaken: 55 } });

  // 1) Unauthenticated.
  await probeRole('unauth', null);

  // 2) Ordinary driver, liquid-gold.
  const driverTok = await tokenFor('u_driver', { kind: 'driver', driverId: 'd1', companyId: 'liquid-gold' });
  await probeRole('driver', async () => { await signInWithCustomToken(cauth, driverTok); });
  // ...and specifically cannot delete another-company/own-company rejected evidence or edit a processed row.
  check('[driver] cannot delete rejected evidence', (await clientWrite('packets/rejected/seed_rej', null)) === 'denied');
  check('[driver] cannot mutate a processed pull field', (await clientWrite('packets/processed/seed_pkt/bblsTaken', 1)) === 'denied');

  // 3) Driver from ANOTHER company.
  const otherTok = await tokenFor('u_other', { kind: 'driver', driverId: 'd2', companyId: 'other-co' });
  await probeRole('other-co-driver', async () => { await signInWithCustomToken(cauth, otherTok); });
  check('[other-co] cannot mutate liquid-gold processed pull', (await clientWrite('packets/processed/seed_pkt/bblsTaken', 2)) === 'denied');

  // 4) Dashboard/platform admin (read power, but writes to server-owned state
  //    still denied — the deployed rules make ALL these paths .write:false).
  const adminTok = await tokenFor('u_admin', { wellbuiltAdmin: true, platformAdminEnabled: true });
  await probeRole('platform-admin', async () => { await signInWithCustomToken(cauth, adminTok); });

  // 5) Staff manager.
  const staffTok = await tokenFor('u_staff', { staffCompanyId: 'liquid-gold', staffRole: 'manager' });
  await probeRole('staff-manager', async () => { await signInWithCustomToken(cauth, staffTok); });

  await signOut(cauth).catch(() => {});

  // 5b) INGEST TRUST (item 2): the trust anchor is `packets/incoming .write:false`
  //     + Admin-SDK-only callable. Prove no client can (a) forge an incoming
  //     packet carrying callable stamps, or (b) tamper with an admin-written
  //     incoming packet after ingest — for EVERY authenticated role.
  await adb.ref('packets/incoming/admin_written_pkt').set({ requestType: 'pull', wellName: 'Gabriel 1', packetId: 'admin_written_pkt', companyId: 'liquid-gold', ingestedBy: 'driver_real', authSource: 'claims', payloadDigest: 'realdigest', bblsTaken: 140 });
  for (const [label, tok] of [['driver', driverTok], ['other-co', otherTok], ['platform-admin', adminTok], ['staff', staffTok]]) {
    await signInWithCustomToken(cauth, tok);
    check(`[${label}] cannot FORGE an incoming packet with callable stamps`, (await clientWrite('packets/incoming/forged_stamped', { requestType: 'pull', wellName: 'Gabriel 1', packetId: 'forged_stamped', ingestedBy: 'driver_real', authSource: 'claims', payloadDigest: 'deadbeef', companyId: 'liquid-gold' })) === 'denied');
    check(`[${label}] cannot TAMPER with an admin-written incoming packet`, (await clientWrite('packets/incoming/admin_written_pkt/bblsTaken', 99999)) === 'denied');
    await signOut(cauth).catch(() => {});
  }

  // 6) Admin SDK RETAINS server access to every coordinator path.
  const adminOk = [];
  for (const [path, value] of PATHS) {
    try { await adb.ref(path).set(value === null ? { placeholder: true } : value); adminOk.push(true); }
    catch { adminOk.push(false); }
  }
  check('Admin SDK retains write to every coordinator/evidence path', adminOk.every(Boolean), `${adminOk.filter(Boolean).length}/${adminOk.length}`);

  console.log('\n=== RULES PROBE (client SDK vs DEPLOYED rules snapshot) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[rulesprobe] fatal', e); process.exit(2); });
