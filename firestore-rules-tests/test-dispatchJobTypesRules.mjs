/**
 * Firestore emulator proof for dispatchJobTypes rules lockdown:
 *
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync \
 *     "node firestore-rules-tests/test-dispatchJobTypesRules.mjs"
 *
 * Proves:
 * 1. Direct client writes (create/update/patch/delete-field) to companies/{companyId}.dispatchJobTypes
 *    are DENIED (403) across UNAUTH, USER, and CLAIM identities.
 * 2. Direct client writes to unrelated company fields (e.g. notes, companyName) SUCCEED (200).
 * 3. Admin SDK writes (Bearer owner) to dispatchJobTypes SUCCEED (200).
 * 4. Company read (get/list) remains open (200).
 */

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PID = 'wellbuilt-sync';
const BASE = `http://${host}/v1/projects/${PID}/databases/(default)/documents`;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, claims = {}) {
  const header = { alg: 'none', typ: 'JWT' };
  const iat = 1754400000;
  const payload = {
    iss: `https://securetoken.google.com/${PID}`,
    aud: PID,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: uid,
    user_id: uid,
    firebase: { sign_in_provider: 'password', identities: {} },
    ...claims,
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

const UNAUTH = null;
const OWNER = 'Bearer owner';
const USER = `Bearer ${token('ordinary-user-1')}`;
const CLAIM = `Bearer ${token('claim-admin-1', { wellbuiltAdmin: true })}`;

const hdrs = (auth) => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}),
});
const s = (v) => ({ stringValue: v });
const b = (v) => ({ booleanValue: v });
const i = (v) => ({ integerValue: String(v) });
const arr = (values) => ({ arrayValue: { values } });
const m = (fields) => ({ mapValue: { fields } });

async function patchDoc(auth, path, fields, mask = null) {
  const qs = mask ? '?' + mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : '';
  const r = await fetch(`${BASE}/${path}${qs}`, {
    method: 'PATCH',
    headers: hdrs(auth),
    body: JSON.stringify({ fields }),
  });
  return r.status;
}

const getDoc = async (auth, path) => (await fetch(`${BASE}/${path}`, { headers: hdrs(auth) })).status;

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
};

async function run() {
  console.log('--- Setting up test fixtures with Admin SDK (Bearer owner) ---');
  // 1. Fixture: company without dispatchJobTypes
  const st1 = await patchDoc(OWNER, 'companies/test-company-jobtypes', {
    name: s('Test Hauler Co'),
    notes: s('Initial notes'),
  });
  check('ADMIN fixture: test-company-jobtypes created', st1, 200);

  // 2. Fixture: company with existing dispatchJobTypes written by Admin SDK
  const sampleDjt = m({
    version: i(1),
    items: arr([
      m({ id: s('pw-1'), code: s('PW'), name: s('Production Water'), workClass: s('pw'), enabled: b(true), order: i(0) }),
    ]),
  });
  const st2 = await patchDoc(OWNER, 'companies/test-configured-djt', {
    name: s('Configured Hauler'),
    dispatchJobTypes: sampleDjt,
  });
  check('ADMIN fixture: test-configured-djt created with dispatchJobTypes via Admin SDK', st2, 200);

  console.log('\n--- Direct client write denials for dispatchJobTypes ---');
  // 1. Unauthenticated direct create containing dispatchJobTypes -> 403
  const cUnauth = await patchDoc(UNAUTH, 'companies/new-unauth-co', {
    name: s('Unauth Co'),
    dispatchJobTypes: sampleDjt,
  });
  check('company create with dispatchJobTypes DENIED for UNAUTH', cUnauth, 403);

  // 2. Authenticated user direct create containing dispatchJobTypes -> 403
  const cUser = await patchDoc(USER, 'companies/new-user-co', {
    name: s('User Co'),
    dispatchJobTypes: sampleDjt,
  });
  check('company create with dispatchJobTypes DENIED for USER', cUser, 403);

  // 3. Custom-claim user direct create containing dispatchJobTypes -> 403
  const cClaim = await patchDoc(CLAIM, 'companies/new-claim-co', {
    name: s('Claim Co'),
    dispatchJobTypes: sampleDjt,
  });
  check('company create with dispatchJobTypes DENIED for CLAIM bearer', cClaim, 403);

  // 4. Authenticated user PATCH adding dispatchJobTypes -> 403
  const pAdd = await patchDoc(USER, 'companies/test-company-jobtypes', {
    dispatchJobTypes: sampleDjt,
  }, ['dispatchJobTypes']);
  check('company update adding dispatchJobTypes DENIED for USER', pAdd, 403);

  // 5. Authenticated user PATCH modifying dispatchJobTypes -> 403
  const pMod = await patchDoc(USER, 'companies/test-configured-djt', {
    dispatchJobTypes: m({
      version: i(1),
      items: arr([
        m({ id: s('pw-1'), code: s('PW'), name: s('Modified Name'), workClass: s('pw'), enabled: b(true), order: i(0) }),
      ]),
    }),
  }, ['dispatchJobTypes']);
  check('company update modifying dispatchJobTypes DENIED for USER', pMod, 403);

  // 6. Claim user PATCH modifying dispatchJobTypes -> 403
  const pClaimMod = await patchDoc(CLAIM, 'companies/test-configured-djt', {
    dispatchJobTypes: m({
      version: i(1),
      items: arr([
        m({ id: s('pw-claim'), code: s('CL'), name: s('Claim Attempt'), workClass: s('pw'), enabled: b(true), order: i(0) }),
      ]),
    }),
  }, ['dispatchJobTypes']);
  check('company update modifying dispatchJobTypes DENIED for CLAIM bearer', pClaimMod, 403);

  // 7. Whole-document replacement attempting to set dispatchJobTypes -> 403
  const pReplace = await patchDoc(USER, 'companies/test-company-jobtypes', {
    name: s('Replaced Name'),
    dispatchJobTypes: sampleDjt,
  });
  check('whole-document replacement containing dispatchJobTypes DENIED for USER', pReplace, 403);

  console.log('\n--- Unrelated company settings remain working for existing cards ---');
  // 8. Authenticated user PATCH modifying unrelated field 'notes' -> 200
  const pNotes = await patchDoc(USER, 'companies/test-company-jobtypes', {
    notes: s('Updated notes via standard settings card'),
  }, ['notes']);
  check('unrelated field update (notes) ALLOWED for USER', pNotes, 200);

  // 9. Authenticated user PATCH modifying multiple unrelated fields -> 200
  const pMulti = await patchDoc(USER, 'companies/test-company-jobtypes', {
    notes: s('Further note edit'),
    timezone: s('America/Denver'),
  }, ['notes', 'timezone']);
  check('unrelated multi-field update (notes, timezone) ALLOWED for USER', pMulti, 200);

  // 10. Authenticated user updating unrelated field on a company WITH dispatchJobTypes -> 200
  const pConfiguredUnrelated = await patchDoc(USER, 'companies/test-configured-djt', {
    notes: s('Company with dispatchJobTypes can still update notes'),
  }, ['notes']);
  check('unrelated update on company with dispatchJobTypes ALLOWED for USER', pConfiguredUnrelated, 200);

  console.log('\n--- Admin SDK write path and client read path ---');
  // 11. Admin SDK (callable) can update dispatchJobTypes -> 200
  const pAdminUpdate = await patchDoc(OWNER, 'companies/test-configured-djt', {
    dispatchJobTypes: m({
      version: i(1),
      items: arr([
        m({ id: s('pw-1'), code: s('PW'), name: s('Production Water'), workClass: s('pw'), enabled: b(true), order: i(0) }),
        m({ id: s('sw-1'), code: s('SW'), name: s('Service Work'), workClass: s('sw'), enabled: b(true), order: i(1) }),
      ]),
    }),
  }, ['dispatchJobTypes']);
  check('Admin SDK write to dispatchJobTypes ALLOWED (Bearer owner)', pAdminUpdate, 200);

  // 12. Client read of company doc including dispatchJobTypes -> 200
  const rRead = await getDoc(UNAUTH, 'companies/test-configured-djt');
  check('read company document containing dispatchJobTypes ALLOWED (UNAUTH)', rRead, 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
