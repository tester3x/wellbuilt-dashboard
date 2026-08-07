/**
 * vc51.9J-C2 — Auth Emulator proof: does the per-session `app` developer
 * claim survive an ID-token refresh, and does WB-S stay uncontaminated?
 *
 * THE QUESTION. WB-S and WB-T are one Firebase project and one UID per
 * driver. The bridge mints WB-T's token with `app:'wbt'` as a DEVELOPER
 * claim on createCustomToken, never via setCustomUserClaims, because the
 * latter writes to the shared Auth user and would contaminate WB-S. That
 * only works if developer claims persist across the refresh-token
 * lifetime of the session they created — otherwise WB-T's claim
 * evaporates on the first hourly refresh.
 *
 * OPT-IN. Requires a running Auth emulator and touches nothing else:
 *
 *   firebase emulators:start --only auth --project demo-wellbuilt-sso
 *   node tools/test-ssoEmulatorClaims.mjs
 *
 * Skips cleanly (exit 0) when the emulator is not running, so it never
 * breaks the default gate. Uses a demo project id and temporary uids
 * only; it never contacts production Firebase.
 */
import { initializeApp as initAdmin, deleteApp as deleteAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { initializeApp as initClient, deleteApp as deleteClientApp } from 'firebase/app';
import {
  getAuth as getClientAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PROJECT_ID = process.env.SSO_EMULATOR_PROJECT || 'demo-wellbuilt-sso';
const DRIVER_ID = 'emu-driver-1';
const UID = `driver_${DRIVER_ID.replace(/-/g, '')}`;
const COMPANY_ID = 'emu-co-1';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

async function emulatorUp() {
  try {
    const res = await fetch(`http://${AUTH_HOST}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

if (!(await emulatorUp())) {
  console.log(`SKIP  Auth emulator not reachable at ${AUTH_HOST}.`);
  console.log('      Start it with:');
  console.log(`      firebase emulators:start --only auth --project ${PROJECT_ID}`);
  process.exit(0);
}

process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;

const adminApp = initAdmin({ projectId: PROJECT_ID }, `sso-emu-admin-${Date.now()}`);
const adminAuth = getAdminAuth(adminApp);

/**
 * Two INDEPENDENT client apps: WB-S and WB-T are separate processes with
 * separate Auth persistence. One shared client would prove nothing.
 */
const wbsApp = initClient({ apiKey: 'emu', projectId: PROJECT_ID }, `wbs-${Date.now()}`);
const wbtApp = initClient({ apiKey: 'emu', projectId: PROJECT_ID }, `wbt-${Date.now()}`);
const wbsAuth = getClientAuth(wbsApp);
const wbtAuth = getClientAuth(wbtApp);
connectAuthEmulator(wbsAuth, `http://${AUTH_HOST}`, { disableWarnings: true });
connectAuthEmulator(wbtAuth, `http://${AUTH_HOST}`, { disableWarnings: true });

/** Count setCustomUserClaims calls so "never used for the exchange" is proven. */
let setCustomUserClaimsCalls = 0;
const realSetCustomUserClaims = adminAuth.setCustomUserClaims.bind(adminAuth);
adminAuth.setCustomUserClaims = async (...args) => {
  setCustomUserClaimsCalls += 1;
  return realSetCustomUserClaims(...args);
};

try {
  // ── 1. One user with the real UID shape ─────────────────────────────
  try { await adminAuth.deleteUser(UID); } catch { /* first run */ }
  await adminAuth.createUser({ uid: UID, disabled: false });
  check('created one emulator user with the real driver_<driverId> uid shape',
    (await adminAuth.getUser(UID)).uid === UID);

  // ── 2. WB-S session: the ordinary manual-login claim set, no `app` ───
  // This mirrors authenticateDriver, which DOES persist claims.
  await adminAuth.setCustomUserClaims(UID, {
    kind: 'driver', driverId: DRIVER_ID, companyId: COMPANY_ID,
  });
  const wbsCallsAfterSetup = setCustomUserClaimsCalls;
  const wbsToken = await adminAuth.createCustomToken(UID, {
    kind: 'driver', driverId: DRIVER_ID, companyId: COMPANY_ID,
  });
  await signInWithCustomToken(wbsAuth, wbsToken);
  const wbsBefore = await wbsAuth.currentUser.getIdTokenResult(true);
  check('WB-S session has driver claims', wbsBefore.claims.kind === 'driver');
  check('WB-S session has NO app claim', wbsBefore.claims.app === undefined,
    String(wbsBefore.claims.app));

  // ── 3. WB-T custom token: same uid, developer claims incl. app ───────
  const wbtToken = await adminAuth.createCustomToken(UID, {
    kind: 'driver', driverId: DRIVER_ID, companyId: COMPANY_ID, app: 'wbt',
  });
  check('the exchange used NO setCustomUserClaims',
    setCustomUserClaimsCalls === wbsCallsAfterSetup,
    `${setCustomUserClaimsCalls - wbsCallsAfterSetup} extra call(s)`);

  // ── 4-5. WB-T signs into its own context; initial token carries app ──
  await signInWithCustomToken(wbtAuth, wbtToken);
  check('WB-T signed in as the SAME uid', wbtAuth.currentUser.uid === UID);
  const wbtInitial = await wbtAuth.currentUser.getIdTokenResult();
  check("WB-T's INITIAL id token carries app:'wbt'", wbtInitial.claims.app === 'wbt',
    String(wbtInitial.claims.app));
  check('WB-T initial token carries the driver claims',
    wbtInitial.claims.kind === 'driver'
    && wbtInitial.claims.driverId === DRIVER_ID
    && wbtInitial.claims.companyId === COMPANY_ID);

  // ── 6-7. Force a refresh through the refresh-token path ─────────────
  // Emulator JWTs are deterministic for the same claims within the same
  // second, so a differing token STRING is not evidence of a refresh.
  // Wait past a second boundary and compare issuedAtTime instead: a later
  // iat can only come from a newly minted token, which forceRefresh
  // obtains through the refresh-token endpoint.
  await new Promise((r) => setTimeout(r, 1200));
  const refreshed = await wbtAuth.currentUser.getIdTokenResult(true);
  check('a REAL refresh occurred (issuedAtTime advanced)',
    Date.parse(refreshed.issuedAtTime) > Date.parse(wbtInitial.issuedAtTime),
    `${wbtInitial.issuedAtTime} -> ${refreshed.issuedAtTime}`);
  check('the refreshed token is a different token string',
    refreshed.token !== wbtInitial.token);
  check("WB-T's REFRESHED id token still carries app:'wbt'",
    refreshed.claims.app === 'wbt', String(refreshed.claims.app));
  check('the refreshed token keeps driver/company identity',
    refreshed.claims.driverId === DRIVER_ID && refreshed.claims.companyId === COMPANY_ID);

  // A second refresh, to rule out a one-shot carry-over.
  const refreshedTwice = await wbtAuth.currentUser.getIdTokenResult(true);
  check("app:'wbt' survives a SECOND refresh", refreshedTwice.claims.app === 'wbt');

  // ── 8. WB-S must be uncontaminated ──────────────────────────────────
  const wbsAfter = await wbsAuth.currentUser.getIdTokenResult(true);
  check('WB-S session STILL has no app claim after WB-T signed in',
    wbsAfter.claims.app === undefined, String(wbsAfter.claims.app));
  check('WB-S session identity is unchanged',
    wbsAfter.claims.driverId === DRIVER_ID && wbsAfter.claims.companyId === COMPANY_ID);

  // ── 9. The user record itself must be clean ─────────────────────────
  const record = await adminAuth.getUser(UID);
  check('the SHARED Auth user record has no app claim',
    record.customClaims?.app === undefined, JSON.stringify(record.customClaims));
  check('total setCustomUserClaims calls equal only the WB-S setup call',
    setCustomUserClaimsCalls === 1, String(setCustomUserClaimsCalls));

  // ── cleanup ─────────────────────────────────────────────────────────
  await signOut(wbtAuth).catch(() => {});
  await signOut(wbsAuth).catch(() => {});
  await adminAuth.deleteUser(UID).catch(() => {});
} finally {
  await deleteClientApp(wbsApp).catch(() => {});
  await deleteClientApp(wbtApp).catch(() => {});
  await deleteAdminApp(adminApp).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
