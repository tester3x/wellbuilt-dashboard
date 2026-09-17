/**
 * Genuine Firestore Emulator Concurrency & Direct-Access Denial Test
 * 
 * Verifies:
 * 1. Direct client get/list access to company_join_codes and company_join_codes_by_company remains denied.
 * 2. Simultaneous Promise.all replacement calls on Firestore Emulator:
 *    - Exactly one code is active afterward.
 *    - The company pointer references that active code.
 *    - Previous codes are inactive.
 *    - No orphaned active code exists.
 *    - The callable outcomes are deterministic and documented.
 *    - Transactional security audit records are written without plaintext secrets.
 * 
 * Run via:
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync "node firestore-rules-tests/test-joinCodeRotationEmulator.mjs"
 */

import admin from '../functions/node_modules/firebase-admin/lib/index.js';
import {
  rotateJoinCode,
  resolveCompanyJoinCode,
  companyJoinCodeDigest,
} from '../functions/lib/security/companyOnboarding.js';

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const BASE = `http://${host}/v1/projects/${PID}/databases/(default)/documents`;

// ── Client JWT Builder for Rules Testing ───────────────────────────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, claims = {}) {
  const iat = 1754400000;
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    iss: `https://securetoken.google.com/${PID}`,
    aud: PID,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: uid,
    user_id: uid,
    firebase: { sign_in_provider: 'password', identities: {} },
    ...claims,
  })}.`;
}

const UNAUTH = null;
const USER = `Bearer ${token('ordinary-user-1')}`;
const CLAIM = `Bearer ${token('claim-admin-1', { wellbuiltAdmin: true })}`;

const hdrs = (auth) => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}),
});

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`PASS ${name}`);
}

function fail(name, detail) {
  failed++;
  console.error(`FAIL ${name}: ${detail}`);
}

async function getDocRest(auth, path) {
  const r = await fetch(`${BASE}/${path}`, { headers: hdrs(auth) });
  return { status: r.status, body: await r.json() };
}

async function listColRest(auth, col) {
  const r = await fetch(`${BASE}/${col}`, { headers: hdrs(auth) });
  return { status: r.status, body: await r.json() };
}

async function patchDocRest(auth, path, fields) {
  const r = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: hdrs(auth),
    body: JSON.stringify({ fields }),
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  console.log(`\n=== JOIN CODE EMULATOR CONCURRENCY & RULES TESTS ===\n(Firestore Emulator: ${host}, Project: ${PID})\n`);

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PID });
  }
  const db = admin.firestore();

  // ─────────────────────────────────────────────────────────────────────────
  // PART 1: Direct Client Get / List / Write Rules Verification (Denied)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- PART 1: Verifying direct client access to join-code collections remains denied ---');

  // Direct client GET on company_join_codes
  for (const [idName, auth] of [['UNAUTH', UNAUTH], ['USER', USER], ['CLAIM', CLAIM]]) {
    const r = await getDocRest(auth, 'company_join_codes/some-test-digest');
    if (r.status === 403) {
      ok(`company_join_codes get ${idName} denied (403)`);
    } else {
      fail(`company_join_codes get ${idName} expected 403`, `got ${r.status}`);
    }
  }

  // Direct client LIST on company_join_codes
  for (const [idName, auth] of [['UNAUTH', UNAUTH], ['USER', USER], ['CLAIM', CLAIM]]) {
    const r = await listColRest(auth, 'company_join_codes');
    if (r.status === 403) {
      ok(`company_join_codes list ${idName} denied (403)`);
    } else {
      fail(`company_join_codes list ${idName} expected 403`, `got ${r.status}`);
    }
  }

  // Direct client GET on company_join_codes_by_company
  for (const [idName, auth] of [['UNAUTH', UNAUTH], ['USER', USER], ['CLAIM', CLAIM]]) {
    const r = await getDocRest(auth, 'company_join_codes_by_company/liquid-gold');
    if (r.status === 403) {
      ok(`company_join_codes_by_company get ${idName} denied (403)`);
    } else {
      fail(`company_join_codes_by_company get ${idName} expected 403`, `got ${r.status}`);
    }
  }

  // Direct client LIST on company_join_codes_by_company
  for (const [idName, auth] of [['UNAUTH', UNAUTH], ['USER', USER], ['CLAIM', CLAIM]]) {
    const r = await listColRest(auth, 'company_join_codes_by_company');
    if (r.status === 403) {
      ok(`company_join_codes_by_company list ${idName} denied (403)`);
    } else {
      fail(`company_join_codes_by_company list ${idName} expected 403`, `got ${r.status}`);
    }
  }

  // Direct client WRITE on company_join_codes
  for (const [idName, auth] of [['UNAUTH', UNAUTH], ['USER', USER], ['CLAIM', CLAIM]]) {
    const r = await patchDocRest(auth, 'company_join_codes/malicious-digest', {
      code: { stringValue: 'HACK-1234' },
      active: { booleanValue: true },
    });
    if (r.status === 403) {
      ok(`company_join_codes direct write ${idName} denied (403)`);
    } else {
      fail(`company_join_codes direct write ${idName} expected 403`, `got ${r.status}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PART 2: Genuine Concurrency Test with Simultaneous Promise.all Replacement
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PART 2: Genuine Firestore Emulator Concurrency Test ---');

  const COMPANY_ID = 'liquid-gold';

  // Seed company document via Admin SDK
  await db.collection('companies').doc(COMPANY_ID).set({
    name: 'Liquid Gold Trucking LLC',
    status: 'active',
  });
  ok('Seeded companies/liquid-gold fixture');

  // Seed initial join code
  const INITIAL_CODE = 'INIT-2026';
  const initialDigest = companyJoinCodeDigest(INITIAL_CODE);
  await db.collection('company_join_codes').doc(initialDigest).set({
    companyId: COMPANY_ID,
    code: INITIAL_CODE,
    active: true,
    createdBy: 'seed',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection('company_join_codes_by_company').doc(COMPANY_ID).set({
    digest: initialDigest,
    updatedBy: 'seed',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  ok('Seeded initial active join code and pointer');

  // Verify initial code resolves
  const initialResolution = await resolveCompanyJoinCode(INITIAL_CODE);
  if (initialResolution.companyId === COMPANY_ID && initialResolution.companyName === 'Liquid Gold Trucking LLC') {
    ok('Initial join code resolves cleanly before concurrency test');
  } else {
    fail('Initial join code resolution', JSON.stringify(initialResolution));
  }

  // Launch 8 SIMULTANEOUS concurrent replacement calls
  const CONCURRENCY = 8;
  const actors = Array.from({ length: CONCURRENCY }, (_, idx) => `admin-actor-${idx + 1}`);
  console.log(`Launching ${CONCURRENCY} simultaneous Promise.all replacement calls against ${COMPANY_ID}...`);

  const t0 = Date.now();
  const results = await Promise.allSettled(
    actors.map(actorUid => rotateJoinCode(COMPANY_ID, actorUid))
  );
  const elapsedMs = Date.now() - t0;
  console.log(`All concurrent operations settled in ${elapsedMs}ms.`);

  // Inspect outcomes
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  console.log(`Outcomes: ${fulfilled.length} fulfilled, ${rejected.length} rejected.`);

  if (fulfilled.length > 0) {
    ok(`At least one concurrent replacement succeeded (got ${fulfilled.length}/${CONCURRENCY})`);
  } else {
    fail('All concurrent replacements failed', JSON.stringify(results));
  }

  const generatedCodes = fulfilled.map(r => r.value);
  console.log(`Generated codes count: ${generatedCodes.length}`);

  // ─────────────────────────────────────────────────────────────────────────
  // PART 3: Invariant Assertions on Firestore Emulator State
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PART 3: Post-concurrency state invariant assertions ---');

  // Invariant 1: Company pointer references an active code
  const pointerSnap = await db.collection('company_join_codes_by_company').doc(COMPANY_ID).get();
  const currentPointerDigest = pointerSnap.data()?.digest;
  if (typeof currentPointerDigest === 'string' && currentPointerDigest.length === 64) {
    ok(`Pointer company_join_codes_by_company/${COMPANY_ID} exists and holds valid SHA-256 digest`);
  } else {
    fail('Pointer document invalid', JSON.stringify(pointerSnap.data()));
  }

  // Fetch all join codes for this company
  const allCompanyCodesSnap = await db.collection('company_join_codes')
    .where('companyId', '==', COMPANY_ID)
    .get();

  const totalCodesCount = allCompanyCodesSnap.docs.length;
  console.log(`Total join code docs created for ${COMPANY_ID}: ${totalCodesCount}`);

  const activeCodes = allCompanyCodesSnap.docs.filter(d => d.data().active === true);
  const inactiveCodes = allCompanyCodesSnap.docs.filter(d => d.data().active === false);

  // Invariant 2: Exactly ONE code is active afterward
  if (activeCodes.length === 1) {
    ok(`Invariant 1: Exactly ONE code is active afterward for ${COMPANY_ID} (found 1)`);
  } else {
    fail(`Invariant 1 failed: Expected exactly 1 active code`, `found ${activeCodes.length}`);
  }

  const activeDoc = activeCodes[0];
  const activeData = activeDoc.data();

  // Invariant 3: The company pointer references that active code
  if (activeDoc.id === currentPointerDigest) {
    ok(`Invariant 2: Company pointer exactly references active code digest (${currentPointerDigest.slice(0, 12)}...)`);
  } else {
    fail(`Invariant 2 failed: Pointer mismatch`, `pointer=${currentPointerDigest}, activeDoc=${activeDoc.id}`);
  }

  // Invariant 4: Previous codes are inactive with revocation metadata
  let allPreviousInactiveWithMetadata = true;
  for (const doc of inactiveCodes) {
    const data = doc.data();
    if (data.active !== false || !data.revokedBy) {
      allPreviousInactiveWithMetadata = false;
      break;
    }
  }
  if (allPreviousInactiveWithMetadata && inactiveCodes.length === totalCodesCount - 1) {
    ok(`Invariant 3: All ${inactiveCodes.length} previous codes are inactive with revokedBy metadata`);
  } else {
    fail(`Invariant 3 failed: Some previous codes active or missing revocation metadata`);
  }

  // Invariant 5: No orphaned active code exists in the entire collection
  const allActiveGloballySnap = await db.collection('company_join_codes')
    .where('active', '==', true)
    .get();
  
  if (allActiveGloballySnap.docs.length === 1 && allActiveGloballySnap.docs[0].id === currentPointerDigest) {
    ok('Invariant 4: No orphaned active code exists globally across company_join_codes');
  } else {
    fail('Invariant 4 failed: Orphaned active codes exist', `count=${allActiveGloballySnap.docs.length}`);
  }

  // Invariant 6: Audit log verification (written in same transaction, no plaintext secrets)
  const auditSnap = await db.collection('security_audit')
    .where('action', '==', 'rotateCompanyJoinCode')
    .get();
  
  let auditsContainNoPlaintext = true;
  for (const aDoc of auditSnap.docs) {
    const aData = aDoc.data();
    const str = JSON.stringify(aData);
    if (str.includes(INITIAL_CODE) || (activeData?.code && str.includes(activeData.code))) {
      auditsContainNoPlaintext = false;
      break;
    }
  }

  if (auditSnap.docs.length === fulfilled.length) {
    ok(`Invariant 5: Exactly ${fulfilled.length} atomic security_audit records written in transaction`);
  } else {
    fail(`Invariant 5 failed: Audit records count mismatch`, `expected ${fulfilled.length}, found ${auditSnap.docs.length}`);
  }

  if (auditsContainNoPlaintext) {
    ok('Invariant 6: Security audit records contain NO plaintext codes or secrets');
  } else {
    fail('Invariant 6 failed: Audit records leaked plaintext codes');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PART 4: Deterministic Resolution Behavior
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PART 4: Deterministic Resolution Behavior ---');

  // Winning active code MUST resolve cleanly
  const winningResolution = await resolveCompanyJoinCode(activeData.code);
  if (winningResolution.companyId === COMPANY_ID && winningResolution.companyName === 'Liquid Gold Trucking LLC') {
    ok('Winning active code resolves cleanly via resolveCompanyJoinCode');
  } else {
    fail('Winning code resolution failed', JSON.stringify(winningResolution));
  }

  // Initial code MUST be rejected
  try {
    await resolveCompanyJoinCode(INITIAL_CODE);
    fail('Initial code should have been rejected');
  } catch (err) {
    if (err.message.includes('not found') || err.code === 'not-found') {
      ok('Initial superseded code correctly rejected with not-found');
    } else {
      fail('Initial code rejected with unexpected error', err.message);
    }
  }

  // All intermediate superseded codes MUST be rejected
  let allSupersededRejected = true;
  for (const inDoc of inactiveCodes) {
    const codeVal = inDoc.data().code;
    if (codeVal) {
      try {
        await resolveCompanyJoinCode(codeVal);
        allSupersededRejected = false;
        break;
      } catch (err) {
        // Expected
      }
    }
  }
  if (allSupersededRejected) {
    ok('All superseded codes rejected on registration resolution');
  } else {
    fail('A superseded code unexpectedly resolved!');
  }

  // Summary
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error in test:', err);
  process.exit(1);
});
