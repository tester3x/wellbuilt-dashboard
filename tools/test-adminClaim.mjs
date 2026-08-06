/**
 * vc51.9A4 — verified platform-admin authority.
 *
 * RED-FIRST against the prior state: before this, the only "admin" signal
 * was the client-visible `viewAdmin` capability read from RTDB/Firestore,
 * which no Cloud Function or security rule can verify. These cases pin
 * the boundary: ONLY a server-assigned custom claim on a verified
 * Firebase ID token authorizes a protected operation.
 *
 * Run: node --experimental-strip-types tools/test-adminClaim.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WELLBUILT_ADMIN_CLAIM,
  authorizePlatformAdmin,
  hasVerifiedAdminClaim,
  buildAdminAuditStamp,
} from '../src/lib/adminClaim.ts';

function expect(cond, msg) { if (!cond) throw new Error(msg); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const UID = 'uid-mike-123';
const admin = { uid: UID, token: { [WELLBUILT_ADMIN_CLAIM]: true, email: 'admin@example.com' } };

// ── Allowed ─────────────────────────────────────────────────────────────────
{
  const a = authorizePlatformAdmin(admin);
  expect(a.ok && a.actorUid === UID && a.actorEmail === 'admin@example.com',
    'verified custom-claim admin is authorized with a server-derived actor');
  const noEmail = authorizePlatformAdmin({ uid: UID, token: { [WELLBUILT_ADMIN_CLAIM]: true } });
  expect(noEmail.ok && noEmail.actorEmail === null, 'missing email degrades to null, not a denial');
}

// ── Denied ──────────────────────────────────────────────────────────────────
expect(authorizePlatformAdmin(null).reason === 'unauthenticated', 'no auth → denied');
expect(authorizePlatformAdmin({ uid: null, token: {} }).reason === 'unauthenticated', 'no uid → denied');
expect(authorizePlatformAdmin({ uid: UID, token: null }).reason === 'unauthenticated', 'no token → denied');
expect(authorizePlatformAdmin({ uid: UID, token: { email: 'x@y.z' } }).reason === 'missing_admin_claim',
  'authenticated ordinary user → denied');
// Truthy-but-not-true must never authorize.
for (const v of ['true', 1, {}, [], 'yes']) {
  expect(authorizePlatformAdmin({ uid: UID, token: { [WELLBUILT_ADMIN_CLAIM]: v } }).reason === 'claim_not_true',
    `truthy non-true claim (${JSON.stringify(v)}) → denied`);
}
expect(authorizePlatformAdmin({ uid: UID, token: { [WELLBUILT_ADMIN_CLAIM]: false } }).reason === 'claim_not_true',
  'explicitly false claim → denied');

// A client-supplied body field can never reach this decision: the function
// takes ONLY request.auth. Pin that the module never reads a body/profile.
{
  const src = readFileSync(join(root, 'src/lib/adminClaim.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(!/\bdata\b|\brequest\.data\b|viewAdmin|firestore|database/i.test(code),
    'authorization reads the verified token only — never a body, profile, or capability');
}
// Firestore/RTDB profile claiming admin, or viewAdmin, is not authority.
expect(!hasVerifiedAdminClaim({ role: 'it', viewAdmin: true }),
  'profile role / viewAdmin is NOT verified admin authority');
expect(hasVerifiedAdminClaim({ [WELLBUILT_ADMIN_CLAIM]: true }), 'token claim is authority');
expect(!hasVerifiedAdminClaim(null) && !hasVerifiedAdminClaim(undefined), 'absent claims → not admin');

// ── Audit stamp ─────────────────────────────────────────────────────────────
{
  const stamp = buildAdminAuditStamp(authorizePlatformAdmin(admin), 'plan.create');
  expect(stamp && stamp.actorUid === UID && stamp.action === 'plan.create' && stamp.atServerTime === true,
    'audit stamp carries the verified actor and demands a server timestamp');
  expect(buildAdminAuditStamp(authorizePlatformAdmin({ uid: UID, token: {} }), 'plan.create') === null,
    'no stamp is produced for an unauthorized caller');
  const keys = Object.keys(stamp);
  expect(!keys.some(k => /token|password|secret/i.test(k)), 'audit stamp carries no credentials');
}

// ── Claim minimality ────────────────────────────────────────────────────────
{
  const src = readFileSync(join(root, 'src/lib/adminClaim.ts'), 'utf8');
  expect(src.includes("WELLBUILT_ADMIN_CLAIM = 'wellbuiltAdmin'"), 'single stable claim name');
  expect(/no company settings|never live in a custom\s*\n \* claim|pure authority bit/i.test(src),
    'claim minimality is documented in place');
}

console.log('adminClaim tests passed');
