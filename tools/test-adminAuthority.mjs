/**
 * vc51.9A5 — server-side platform-admin authority matrix.
 *
 * RED-FIRST: before this, the only server-side notion of "admin" was the
 * token claim alone, which cannot be revoked before an issued token
 * expires. These cases pin the dual gate (claim AND enabled server
 * record) and prove every partial bootstrap/teardown state fails closed.
 *
 * Run: node --experimental-strip-types tools/test-adminAuthority.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WELLBUILT_ADMIN_CLAIM, ADMIN_POLICY_VERSION, PLATFORM_ADMINS_COLLECTION,
  authorizeAdminCall, ENABLE_ORDER, DISABLE_ORDER,
  authorizesAfterEnableSteps, authorizesAfterDisableSteps,
} from '../functions/src/admin/authority.ts';

function expect(c, m) { if (!c) throw new Error(m); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UID = 'uid-mike-123';
const tok = (extra = {}) => ({ uid: UID, token: { [WELLBUILT_ADMIN_CLAIM]: true, email: 'a@b.c', ...extra } });
const rec = (o = {}) => ({ enabled: true, policyVersion: ADMIN_POLICY_VERSION, ...o });

// Allowed: claim AND enabled record.
{
  const a = authorizeAdminCall(tok(), rec());
  expect(a.ok && a.actorUid === UID && a.actorEmail === 'a@b.c' && a.policyVersion === 1,
    'claim + enabled record authorizes with a server-derived actor');
}
// Denied — authentication / claim.
expect(authorizeAdminCall(null, rec()).reason === 'unauthenticated', 'unauthenticated denied');
expect(authorizeAdminCall({ uid: UID, token: {} }, rec()).reason === 'missing_admin_claim',
  'ordinary authenticated user denied');
for (const v of ['true', 1, {}, false]) {
  expect(authorizeAdminCall({ uid: UID, token: { [WELLBUILT_ADMIN_CLAIM]: v } }, rec()).reason === 'claim_not_true',
    `non-true claim ${JSON.stringify(v)} denied`);
}
// Denied — server record.
expect(authorizeAdminCall(tok(), null).reason === 'no_admin_record',
  'claim WITHOUT an enabled record denied');
expect(authorizeAdminCall(tok(), rec({ enabled: false })).reason === 'admin_record_disabled',
  'disabled record denies immediately, without waiting for token expiry');
expect(authorizeAdminCall(tok(), { enabled: 'yes', policyVersion: 1 }).reason === 'admin_record_malformed',
  'malformed enabled flag denied');
expect(authorizeAdminCall(tok(), { enabled: true }).reason === 'admin_record_malformed',
  'record without policyVersion denied');
expect(authorizeAdminCall(tok(), rec({ policyVersion: 999 })).reason === 'unsupported_policy_version',
  'unknown policy version fails closed');
// Record alone proves nothing.
expect(authorizeAdminCall({ uid: UID, token: { email: 'a@b.c' } }, rec()).reason === 'missing_admin_claim',
  'enabled record WITHOUT the claim denied');

// Bootstrap ordering: every partial enable state denies.
expect(ENABLE_ORDER[0] === 'create_pending_record' && ENABLE_ORDER[ENABLE_ORDER.length - 1] === 'enable_record',
  'enable order creates a pending record first and enables last');
expect(!authorizesAfterEnableSteps([]) &&
  !authorizesAfterEnableSteps(['create_pending_record']) &&
  !authorizesAfterEnableSteps(['create_pending_record', 'set_claim']) &&
  !authorizesAfterEnableSteps(['create_pending_record', 'set_claim', 'verify_claim']),
  'every partial enable state fails closed (pending record cannot authorize)');
expect(authorizesAfterEnableSteps([...ENABLE_ORDER]), 'only the complete enable sequence authorizes');
// Teardown: the first step already blocks.
expect(DISABLE_ORDER[0] === 'disable_record', 'disable order disables the server record FIRST');
expect(!authorizesAfterDisableSteps(['disable_record']),
  'disabling the record blocks the next call even while the claim is stale');

// The server helper must not consult unsafe sources.
{
  const src = readFileSync(join(root, 'functions/src/admin/authority.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(!/viewAdmin|request\.data|\bdata\.|firestore\(|getDatabase|allowlist/i.test(code),
    'authority consults only verified auth + the server record');
  expect(!/import .*['"]\.\.\/\.\.\/\.\.\//.test(code),
    'no import escapes the Functions build boundary');
  expect(src.includes(`'${PLATFORM_ADMINS_COLLECTION}'`) || src.includes('platform_admins'),
    'server-owned admin state lives in platform_admins/{uid}');
}
console.log('adminAuthority tests passed');
