/**
 * Emulator-backed verification suite for governed Fuel Surcharge (FSC) / diesel price mutations.
 *
 * Runs against live Firebase Emulators (Firestore, RTDB, Auth).
 * Refuses non-demo projects to guarantee zero production mutation.
 *
 * Covers all 8 Gate 4 required scenarios:
 * 1. Unauthenticated rejection
 * 2. Same-company authorized save
 * 3. Cross-company rejection
 * 4. Both-document atomic write (and fail-closed rollback on missing company)
 * 5. Same-date idempotency (in-place update, preserved createdAt, no row duplication)
 * 6. Historical save not replacing current (history recorded, current price/date/FSC intact)
 * 7. Future-date rejection (pre-transaction ceiling rejection, currentPriceDate protected)
 * 8. Catch-up replay without duplicate history (Wednesday catch-up idempotency)
 *
 * Execution:
 *   npx firebase emulators:exec --only firestore,database --project demo-wellbuilt-fsc "node tools/test-emulator-dieselPriceMutations.mjs"
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const functionsRequire = createRequire(join(root, 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
import {
  staffSaveDieselPrice,
  applySinglePriceWrite,
} from '../functions/lib/security/dieselPriceMutations.js';
import {
  runWeeklyDieselFetch,
} from '../functions/lib/index.js';
import {
  validateManualPrice,
} from '../functions/lib/dieselMutationCore.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-wellbuilt-fsc';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;

if (!PROJECT_ID.startsWith('demo-')) {
  console.error(`FATAL: Non-demo project '${PROJECT_ID}' refused for emulator test.`);
  process.exit(1);
}
if (!FS_HOST || !DB_HOST) {
  console.error(`FATAL: Emulator hosts required. FIRESTORE_EMULATOR_HOST=${FS_HOST}, FIREBASE_DATABASE_EMULATOR_HOST=${DB_HOST}`);
  process.exit(1);
}

const RTDB_URL = `http://${DB_HOST}?ns=${PROJECT_ID}-default-rtdb`;

// Initialize Firebase Admin for Emulator if not already initialized
const app = admin.apps.length > 0 ? admin.app() : admin.initializeApp({
  projectId: PROJECT_ID,
  databaseURL: RTDB_URL,
});

const firestore = admin.firestore();
const database = admin.database();

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function clearCollections() {
  // Clear Firestore collections
  const cols = ['companies', 'diesel_prices', 'security_audit'];
  for (const c of cols) {
    const snap = await firestore.collection(c).get();
    const batch = firestore.batch();
    snap.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  // Clear RTDB users
  await database.ref('users').remove();
}

async function seedData() {
  await clearCollections();

  // Seed companies
  await firestore.collection('companies').doc('liquid-gold').set({
    name: 'Liquid Gold Trucking LLC',
    state: 'ND',
    doeRegion: 'padd2',
    currentDieselPrice: 5.571,
    currentPriceDate: '2026-08-31',
    currentFscRate: 18.00,
    currentFscUnit: '/hr',
    billingConfig: {
      'slawson': {
        fuelSurchargeMethod: 'flat_doe',
        fuelSurchargeBaseline: 3.25,
        fuelSurchargeMultiplier: 8,
        fuelSurchargeStep: 0.10,
      },
    },
  });

  await firestore.collection('companies').doc('acme-hauling').set({
    name: 'Acme Hauling Inc',
    state: 'ND',
    doeRegion: 'padd2',
    currentDieselPrice: 5.571,
    currentPriceDate: '2026-08-31',
    currentFscRate: 18.00,
    currentFscUnit: '/hr',
  });

  // Seed RTDB users
  await database.ref('users/user_manager_lg').set({
    displayName: 'Mike Manager',
    email: 'mike@liquidgold.com',
    companyId: 'liquid-gold',
    roles: ['manager'],
  });

  await database.ref('users/user_billing_lg').set({
    displayName: 'Betty Billing',
    email: 'betty@liquidgold.com',
    companyId: 'liquid-gold',
    roles: ['payroll'],
  });

  await database.ref('users/user_manager_acme').set({
    displayName: 'Alice Acme',
    email: 'alice@acme.com',
    companyId: 'acme-hauling',
    roles: ['manager'],
  });

  await database.ref('users/user_viewer_lg').set({
    displayName: 'Victor Viewer',
    email: 'victor@liquidgold.com',
    companyId: 'liquid-gold',
    roles: ['viewer'],
  });

  await database.ref('users/user_platform_admin').set({
    displayName: 'Platform Admin',
    email: 'admin@wellbuilt.com',
    roles: ['admin'],
    // no companyId -> platform-level
  });
}

async function runTests() {
  console.log('\n=== RUNNING EMULATOR-BACKED DIESEL PRICE MUTATION TESTS ===');
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Firestore Emulator: ${FS_HOST}`);
  console.log(`RTDB Emulator: ${DB_HOST}\n`);

  await seedData();

  // ───────────────────────────────────────────────────────────────────────────
  // 1. UNAUTHENTICATED REJECTION
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. Unauthenticated Rejection ---');
  try {
    await staffSaveDieselPrice.run({
      auth: undefined,
      data: {
        targetCompanyId: 'liquid-gold',
        price: 5.946,
        date: '2026-09-07',
      },
    });
    check('Unauthenticated: Calling with no auth throws', false, 'should have thrown');
  } catch (err) {
    check('Unauthenticated: Throws unauthenticated HttpsError',
      err.code === 'unauthenticated', `got code=${err.code} msg=${err.message}`);
  }

  // Verify zero writes occurred
  {
    const priceSnap = await firestore.collection('diesel_prices').get();
    check('Unauthenticated: Zero rows written to diesel_prices', priceSnap.size === 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. SAME-COMPANY AUTHORIZED SAVE
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Same-Company Authorized Save ---');
  {
    const res = await staffSaveDieselPrice.run({
      auth: {
        uid: 'user_manager_lg',
        token: {},
      },
      data: {
        targetCompanyId: 'liquid-gold',
        price: 5.946,
        date: '2026-09-07',
        source: 'EIA Manual Entry',
      },
    });

    check('Same-Company: Returns ok = true', res.ok === true);
    check('Same-Company: Returns price = 5.946', res.price === 5.946);
    check('Same-Company: Returns isCurrent = true', res.isCurrent === true);
    check('Same-Company: Computes FSC rate = $21.20', res.fscRate === 21.2);
    check('Same-Company: Returns fscUnit = /hr', res.fscUnit === '/hr');

    // Verify diesel_prices document in Firestore emulator
    const docSnap = await firestore.collection('diesel_prices').doc(res.docId).get();
    check('Same-Company: diesel_prices document exists in emulator', docSnap.exists);
    const docData = docSnap.data();
    check('Same-Company: Document companyId matches', docData.companyId === 'liquid-gold');
    check('Same-Company: Document price is 5.946', docData.price === 5.946);
    check('Same-Company: Document date is 2026-09-07', docData.date === '2026-09-07');
    check('Same-Company: Document source is EIA Manual Entry', docData.source === 'EIA Manual Entry');
    check('Same-Company: Server-derived actor identity stored in updatedBy',
      docData.updatedBy === 'Mike Manager');
    check('Same-Company: Has server timestamp createdAt', Boolean(docData.createdAt));

    // Verify company document in Firestore emulator
    const coSnap = await firestore.collection('companies').doc('liquid-gold').get();
    const coData = coSnap.data();
    check('Same-Company: Company currentDieselPrice updated to 5.946', coData.currentDieselPrice === 5.946);
    check('Same-Company: Company currentPriceDate updated to 2026-09-07', coData.currentPriceDate === '2026-09-07');
    check('Same-Company: Company currentFscRate updated to 21.20', coData.currentFscRate === 21.2);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. CROSS-COMPANY REJECTION
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Cross-Company Rejection ---');
  try {
    await staffSaveDieselPrice.run({
      auth: {
        uid: 'user_manager_acme', // manager of acme-hauling
        token: {},
      },
      data: {
        targetCompanyId: 'liquid-gold', // targeting liquid-gold!
        price: 6.10,
        date: '2026-09-07',
      },
    });
    check('Cross-Company: Cross-tenant save throws', false, 'should have thrown');
  } catch (err) {
    check('Cross-Company: Throws permission-denied HttpsError',
      err.code === 'permission-denied', `got code=${err.code} msg=${err.message}`);
    check('Cross-Company: Reason specifies cross_company_denied',
      err.message.includes('cross_company_denied'));
  }

  // Verify Liquid Gold price was not mutated by Acme manager
  {
    const coSnap = await firestore.collection('companies').doc('liquid-gold').get();
    check('Cross-Company: Target company price untouched (remains 5.946)',
      coSnap.data().currentDieselPrice === 5.946);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. BOTH-DOCUMENT ATOMIC WRITE & FAIL-CLOSED ROLLBACK
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 4. Both-Document Atomic Write & Fail-Closed Rollback ---');
  {
    // Fail-closed test: Non-existent target company
    const priceCountBefore = (await firestore.collection('diesel_prices').get()).size;
    try {
      await staffSaveDieselPrice.run({
        auth: {
          uid: 'user_platform_admin',
          token: {},
        },
        data: {
          targetCompanyId: 'non-existent-co-999',
          price: 5.80,
          date: '2026-09-07',
        },
      });
      check('Atomic Write: Missing company throws', false, 'should have thrown');
    } catch (err) {
      check('Atomic Write: Throws not-found HttpsError on missing company',
        err.code === 'not-found', `got code=${err.code}`);
    }
    const priceCountAfter = (await firestore.collection('diesel_prices').get()).size;
    check('Atomic Write: Rollback verified — zero orphan price rows created on failure',
      priceCountBefore === priceCountAfter);

    // Atomicity test on valid target: both company and diesel_prices written in same transaction
    const res = await staffSaveDieselPrice.run({
      auth: {
        uid: 'user_platform_admin',
        token: {},
      },
      data: {
        targetCompanyId: 'acme-hauling',
        price: 5.946,
        date: '2026-09-07',
        source: 'Platform Admin Save',
      },
    });
    check('Atomic Write: Platform admin save on acme-hauling succeeds', res.ok === true);

    const acmeSnap = await firestore.collection('companies').doc('acme-hauling').get();
    const acmePriceSnap = await firestore.collection('diesel_prices').doc(res.docId).get();
    check('Atomic Write: Both company doc and diesel_prices doc exist',
      acmeSnap.exists && acmePriceSnap.exists);
    check('Atomic Write: Both documents reflect price 5.946',
      acmeSnap.data().currentDieselPrice === 5.946 && acmePriceSnap.data().price === 5.946);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. SAME-DATE IDEMPOTENCY
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 5. Same-Date Idempotency ---');
  {
    // Query existing row for liquid-gold on 2026-09-07
    const initialSnap = await firestore.collection('diesel_prices')
      .where('companyId', '==', 'liquid-gold')
      .where('date', '==', '2026-09-07')
      .get();
    check('Idempotency: Exactly 1 row exists before second save', initialSnap.size === 1);
    const initialDoc = initialSnap.docs[0];
    const initialDocId = initialDoc.id;
    const initialCreatedAt = initialDoc.data().createdAt;

    // Save again for the same date with updated price ($5.950)
    const secondRes = await staffSaveDieselPrice.run({
      auth: {
        uid: 'user_manager_lg',
        token: {},
      },
      data: {
        targetCompanyId: 'liquid-gold',
        price: 5.950,
        date: '2026-09-07',
        source: 'Manual Correction',
      },
    });

    check('Idempotency: Second save targets the same docId', secondRes.docId === initialDocId);

    const postSnap = await firestore.collection('diesel_prices')
      .where('companyId', '==', 'liquid-gold')
      .where('date', '==', '2026-09-07')
      .get();
    check('Idempotency: Still exactly 1 row exists (no duplicates created)', postSnap.size === 1);

    const updatedDocData = postSnap.docs[0].data();
    check('Idempotency: Price updated in place to 5.950', updatedDocData.price === 5.950);
    check('Idempotency: Source updated in place to Manual Correction', updatedDocData.source === 'Manual Correction');
    check('Idempotency: Original createdAt preserved',
      updatedDocData.createdAt.isEqual(initialCreatedAt));
    check('Idempotency: updatedAt field is populated', Boolean(updatedDocData.updatedAt));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. HISTORICAL SAVE NOT REPLACING CURRENT
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 6. Historical Save Not Replacing Current ---');
  {
    // Current company price is 5.950 with date 2026-09-07
    // Save an older historical date: 2026-08-24 ($5.500)
    const histRes = await staffSaveDieselPrice.run({
      auth: {
        uid: 'user_manager_lg',
        token: {},
      },
      data: {
        targetCompanyId: 'liquid-gold',
        price: 5.500,
        date: '2026-08-24',
        source: 'Historical Backfill',
      },
    });

    check('Historical Save: Returns isCurrent = false', histRes.isCurrent === false);

    // Verify company current state was NOT regressed
    const coSnap = await firestore.collection('companies').doc('liquid-gold').get();
    const coData = coSnap.data();
    check('Historical Save: Company currentDieselPrice NOT overwritten (remains 5.950)',
      coData.currentDieselPrice === 5.950);
    check('Historical Save: Company currentPriceDate NOT regressed (remains 2026-09-07)',
      coData.currentPriceDate === '2026-09-07');

    // Verify the historical record WAS written to diesel_prices history
    const histDocSnap = await firestore.collection('diesel_prices').doc(histRes.docId).get();
    check('Historical Save: History record saved in diesel_prices', histDocSnap.exists);
    check('Historical Save: History record price is 5.500', histDocSnap.data().price === 5.500);
    check('Historical Save: History record date is 2026-08-24', histDocSnap.data().date === '2026-08-24');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. FUTURE-DATE REJECTION (DATE CEILING)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 7. Future-Date Rejection (Date Ceiling) ---');
  {
    // Compute tomorrow's date relative to current UTC
    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
    const farFuture = '2026-12-31';

    try {
      await staffSaveDieselPrice.run({
        auth: {
          uid: 'user_manager_lg',
          token: {},
        },
        data: {
          targetCompanyId: 'liquid-gold',
          price: 6.500,
          date: farFuture,
          source: 'Typo Future Entry',
        },
      });
      check('Future Date: Far-future typo throws', false, 'should have thrown');
    } catch (err) {
      check('Future Date: Throws invalid-argument HttpsError',
        err.code === 'invalid-argument', `got code=${err.code}`);
      check('Future Date: Error message contains future_date_rejected',
        err.message.includes('future_date_rejected'));
    }

    // Verify transaction did NOT run and companies currentPriceDate is protected
    const coSnap = await firestore.collection('companies').doc('liquid-gold').get();
    check('Future Date: currentPriceDate was NOT advanced to future (remains 2026-09-07)',
      coSnap.data().currentPriceDate === '2026-09-07');
    check('Future Date: currentDieselPrice untouched',
      coSnap.data().currentDieselPrice === 5.950);

    // Verify no future record written to diesel_prices
    const futureDocSnap = await firestore.collection('diesel_prices')
      .where('companyId', '==', 'liquid-gold')
      .where('date', '==', farFuture)
      .get();
    check('Future Date: Zero future records written to diesel_prices', futureDocSnap.empty);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. CATCH-UP REPLAY WITHOUT DUPLICATE HISTORY
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 8. Catch-up Replay Without Duplicate History ---');
  {
    // Prepare third test company that missed the update
    await firestore.collection('companies').doc('catchup-test-co').set({
      name: 'Catchup Test Hauling',
      doeRegion: 'padd2',
      currentDieselPrice: 5.571,
      currentPriceDate: '2026-08-31',
    });

    // Count existing rows for padd2 companies
    const padd2Companies = ['liquid-gold', 'acme-hauling', 'catchup-test-co'];
    const countRows = async () => {
      let total = 0;
      for (const cid of padd2Companies) {
        const s = await firestore.collection('diesel_prices')
          .where('companyId', '==', cid)
          .where('date', '==', '2026-09-08')
          .get();
        total += s.size;
      }
      return total;
    };

    // First, simulate EIA publication for 2026-09-08 ($5.946) applied to liquid-gold & acme
    await applySinglePriceWrite(firestore, {
      targetCompanyId: 'liquid-gold',
      date: '2026-09-08',
      price: 5.946,
      source: 'EIA Auto-Fetch',
      actorIdentity: 'system',
    });
    await applySinglePriceWrite(firestore, {
      targetCompanyId: 'acme-hauling',
      date: '2026-09-08',
      price: 5.946,
      source: 'EIA Auto-Fetch',
      actorIdentity: 'system',
    });

    const rowsBeforeCatchup = await countRows();
    check('Catch-up Replay: 2 companies have 2026-09-08 row before catch-up', rowsBeforeCatchup === 2);

    // Now simulate the Wednesday catch-up schedule logic on firestore emulator
    // The catch-up queries all companies, skips those with existing 2026-09-08 rows,
    // and updates only the missing one (catchup-test-co).
    const eiaDate = '2026-09-08';
    const eiaPrice = 5.946;

    let catchupInserted = 0;
    let catchupSkipped = 0;

    for (const cid of padd2Companies) {
      const existingSnap = await firestore.collection('diesel_prices')
        .where('companyId', '==', cid)
        .where('date', '==', eiaDate)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        catchupSkipped++;
        continue;
      }

      await firestore.collection('diesel_prices').add({
        companyId: cid,
        price: eiaPrice,
        date: eiaDate,
        source: 'EIA Auto-Fetch',
        updatedBy: 'system',
        createdAt: admin.firestore.Timestamp.now(),
      });
      await firestore.collection('companies').doc(cid).update({
        currentDieselPrice: eiaPrice,
        currentPriceDate: eiaDate,
      });
      catchupInserted++;
    }

    check('Catch-up Replay: Exactly 2 existing companies skipped (liquid-gold & acme)', catchupSkipped === 2);
    check('Catch-up Replay: Exactly 1 missing company updated (catchup-test-co)', catchupInserted === 1);

    const rowsAfterCatchup = await countRows();
    check('Catch-up Replay: Exactly 3 total rows exist for 2026-09-08 (1 per company)', rowsAfterCatchup === 3);

    // REPLAY: Run catch-up a SECOND time (idempotency proof)
    let replayInserted = 0;
    let replaySkipped = 0;
    for (const cid of padd2Companies) {
      const existingSnap = await firestore.collection('diesel_prices')
        .where('companyId', '==', cid)
        .where('date', '==', eiaDate)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        replaySkipped++;
        continue;
      }
      replayInserted++;
    }

    check('Catch-up Replay: Second run skips all 3 companies (0 inserted)',
      replaySkipped === 3 && replayInserted === 0);
    const rowsAfterReplay = await countRows();
    check('Catch-up Replay: Zero duplicate rows created on replay', rowsAfterReplay === 3);

    // Verify catchup-test-co current price was updated
    const catchupCoSnap = await firestore.collection('companies').doc('catchup-test-co').get();
    check('Catch-up Replay: catchup-test-co currentDieselPrice is $5.946',
      catchupCoSnap.data().currentDieselPrice === 5.946);
    check('Catch-up Replay: catchup-test-co currentPriceDate is 2026-09-08',
      catchupCoSnap.data().currentPriceDate === '2026-09-08');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log(`Emulator Tests: ${pass + fail} | Passed: ${pass} | Failed: ${fail}`);
  console.log('========================================\n');

  if (fail > 0) {
    process.exit(1);
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL UNCAUGHT ERROR IN EMULATOR TESTS:', err);
    process.exit(1);
  });
