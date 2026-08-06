#!/usr/bin/env node
/**
 * ONE-TIME platform-admin claim bootstrap (vc51.9A4) — NOT EXECUTED.
 *
 * Assigns the single authority bit `wellbuiltAdmin: true` to ONE explicit
 * Firebase Auth UID through the Admin SDK. This is the only sanctioned way
 * the claim is ever set; no client, callable, or UI may grant it.
 *
 *   node tools/bootstrap-admin-claim.mjs --uid <FIREBASE_AUTH_UID> --confirm
 *   node tools/bootstrap-admin-claim.mjs --uid <FIREBASE_AUTH_UID> --remove --confirm
 *
 * REQUIRES privileged Admin SDK credentials supplied by the ENVIRONMENT —
 * never embedded here:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 * The script refuses to run without them.
 *
 * OBTAINING THE UID (never authorize by email alone — emails are mutable
 * and are not the identity a token carries):
 *   a) Firebase console → Authentication → Users → copy the User UID; or
 *   b) the signed-in Dashboard session's own profile display (auth.uid).
 * The script takes the UID verbatim and never searches by email.
 *
 * SAFETY PROPERTIES
 *   - single UID only; batch/wildcard input is refused;
 *   - existing unrelated claims are read first and preserved;
 *   - --confirm is mandatory (a dry run prints the plan and exits);
 *   - the result is read back and verified after writing;
 *   - prints the UID and claim NAMES only — never tokens or passwords;
 *   - removal is a separate explicit operation, not a toggle.
 *
 * AUDIT + RECOVERY
 *   - Record who ran it, when, the target UID, and the before/after claim
 *     names in the operations log; Firebase logs the Admin SDK call.
 *   - The claim reaches a session only after the client refreshes its ID
 *     token (Dashboard: "Refresh administrator access"); no logout needed.
 *   - Recovery/revocation: re-run with --remove --confirm, then have the
 *     account refresh its token (or revoke refresh tokens) so the UI and
 *     callables re-lock. Keep at least two bootstrapped admins so a single
 *     lost account cannot orphan platform administration.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const uid = value('uid');
const remove = flag('remove');
const confirmed = flag('confirm');
const CLAIM = 'wellbuiltAdmin';

function fail(msg) { console.error(`refused: ${msg}`); process.exit(1); }

if (!uid || uid.startsWith('--')) fail('--uid <FIREBASE_AUTH_UID> is required (never an email)');
if (uid.includes(',') || uid.includes('*') || uid.includes(' ')) fail('one explicit UID only — batch/wildcard input is not supported');
if (uid.includes('@')) fail('that looks like an email; supply the Firebase Auth UID');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fail('privileged Admin SDK credentials are required (set GOOGLE_APPLICATION_CREDENTIALS)');
}

const { initializeApp, applicationDefault, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
if (!getApps().length) initializeApp({ credential: applicationDefault() });
const auth = getAuth();

const user = await auth.getUser(uid);
const before = user.customClaims || {};
const beforeNames = Object.keys(before);
console.log(`target uid : ${uid}`);
console.log(`claims now : ${beforeNames.length ? beforeNames.join(', ') : '(none)'}`);
console.log(`operation  : ${remove ? `remove ${CLAIM}` : `set ${CLAIM}=true`}`);

if (!confirmed) {
  console.log('\ndry run — nothing written. Re-run with --confirm to apply.');
  process.exit(0);
}

// Preserve every unrelated claim; only this one bit changes.
const next = { ...before };
if (remove) delete next[CLAIM]; else next[CLAIM] = true;
await auth.setCustomUserClaims(uid, next);

// Read back and verify rather than trusting the write.
const after = (await auth.getUser(uid)).customClaims || {};
const ok = remove ? after[CLAIM] === undefined : after[CLAIM] === true;
const preserved = beforeNames.filter((k) => k !== CLAIM).every((k) => k in after);
console.log(`claims after: ${Object.keys(after).join(', ') || '(none)'}`);
console.log(`verified    : ${ok ? 'yes' : 'NO'} | unrelated claims preserved: ${preserved ? 'yes' : 'NO'}`);
if (!ok || !preserved) process.exit(1);
console.log('\nThe target must refresh its ID token before the change takes effect');
console.log('(Dashboard → "Refresh administrator access"). No logout is required.');
