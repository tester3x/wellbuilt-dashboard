#!/usr/bin/env node
/**
 * ONE-TIME platform-admin DUAL-GATE bootstrap (vc51.9A6-C) — NOT EXECUTED.
 *
 * Server authority requires BOTH gates (functions/src/admin/authority.ts):
 *   1. the Firebase Auth custom claim `wellbuiltAdmin: true`, and
 *   2. an exact ENABLED `platform_admins/{uid}` Firestore record.
 * The vc51.9A4 predecessor of this script set only the claim — running
 * it alone left every admin call denied at gate 2. This version
 * establishes and tears down BOTH gates in the fail-closed order proven
 * by tools/test-adminBootstrap.mjs, via tools/lib/adminBootstrapCore.mjs
 * (the exact orchestration under test — this file only wires real deps).
 *
 *   node tools/bootstrap-admin-claim.mjs --uid <FIREBASE_AUTH_UID>            # dry-run plan
 *   node tools/bootstrap-admin-claim.mjs --uid <FIREBASE_AUTH_UID> --confirm  # enable
 *   node tools/bootstrap-admin-claim.mjs --uid <UID> --disable --confirm      # disable
 *   node tools/bootstrap-admin-claim.mjs --uid <UID> --disable --revoke-tokens --confirm
 *
 * ENABLE:  pending/disabled record → set claim (unrelated claims
 *          preserved) → verify claim → enable record → verify both
 *          gates with the REAL authorizeAdminCall decision.
 * DISABLE: disable record FIRST (denial is immediate) → verify denial →
 *          remove only `wellbuiltAdmin` → optional refresh-token
 *          revocation ONLY with the separate --revoke-tokens flag.
 *
 * REQUIRES privileged Admin SDK credentials from the ENVIRONMENT — never
 * embedded here: GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 * The script refuses to run without them, BEFORE loading the SDK.
 *
 * SAFETY: one explicit UID only (emails, wildcards, batches refused);
 * dry-run by default; reruns idempotent; an existing record with an
 * unsupported policyVersion fails closed; partial failure always leaves
 * a DENYING state and prints the exact recovery step; output contains
 * only the UID, claim NAMES, and record state — never tokens, passwords,
 * or keys. There is no self-promotion path from a browser: this tool is
 * the only sanctioned writer of either gate.
 */

import { runDisable, runEnable } from './lib/adminBootstrapCore.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const uid = value('uid');
const disable = flag('disable') || flag('remove');
const confirm = flag('confirm');
const revokeTokens = flag('revoke-tokens');

function refuse(msg) { console.error(`refused: ${msg}`); process.exit(1); }

if (!uid || uid.startsWith('--')) refuse('--uid <FIREBASE_AUTH_UID> is required (never an email)');
if (uid.includes(',') || uid.includes('*') || uid.includes(' ')) refuse('one explicit UID only — batch/wildcard input is not supported');
if (uid.includes('@')) refuse('that looks like an email; supply the Firebase Auth UID');
if (revokeTokens && !disable) refuse('--revoke-tokens only applies to --disable');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  refuse('privileged Admin SDK credentials are required (set GOOGLE_APPLICATION_CREDENTIALS)');
}

const { initializeApp, applicationDefault, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
const { authorizeAdminCall, PLATFORM_ADMINS_COLLECTION } = await import('../functions/lib/admin/authority.js');

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

const deps = {
  getClaims: async (u) => (await auth.getUser(u)).customClaims ?? {},
  setClaims: (u, claims) => auth.setCustomUserClaims(u, claims),
  getRecord: async (u) => {
    const snap = await db.collection(PLATFORM_ADMINS_COLLECTION).doc(u).get();
    return snap.exists ? snap.data() : null;
  },
  setRecord: (u, fields) => db.collection(PLATFORM_ADMINS_COLLECTION).doc(u).set(fields, { merge: true }),
  revokeTokens: (u) => auth.revokeRefreshTokens(u),
  serverTimestamp: () => FieldValue.serverTimestamp(),
  authorize: authorizeAdminCall,
  log: (line) => console.log(line),
};

const result = disable
  ? await runDisable(deps, uid, { confirm, revokeTokens })
  : await runEnable(deps, uid, { confirm });
process.exit(result.ok ? 0 : 1);
