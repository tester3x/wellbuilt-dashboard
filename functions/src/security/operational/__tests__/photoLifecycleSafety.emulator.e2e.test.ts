/**
 * Comprehensive emulator test suite for Photo/Lifecycle Safety across 9 scenarios.
 *
 * Exercises upsertDriverInvoice (with intent: 'photo_patch') and patchDriverInvoicePhotos
 * against real Firestore and RTDB emulators.
 *
 * Scenarios:
 * 1. Active job remains active (in_progress, no closedAt)
 * 2. Paused / back travel state preserved (driverState: 'paused' untouched)
 * 3. Multiple hauls / DDJD preserved (haul 1 & haul 2 untouched)
 * 4. Attempted lifecycle smuggling rejected (fail-closed on status/closedAt/etc.)
 * 5. Metadata update accepted (monotonic merge without duplicates)
 * 6. Forged companyId / invalid docId rejected
 * 7. Explicit close still succeeds afterward
 * 8. Late photo retry on closed job does not corrupt or reopen
 * 9. Concurrency test: simultaneous photo patch and explicit close resolve deterministically
 */

import * as admin from 'firebase-admin';

const FS = process.env.FIRESTORE_EMULATOR_HOST;
const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeE2E = FS ? describe : describe.skip;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-photo-lifecycle';

const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'acme-hauling';
const DRIVER_ID = 'drv-photo-safe-1';
const OTHER_DRIVER_ID = 'drv-other-2';

function initApp(): admin.app.App {
  if (!admin.apps.length) {
    return admin.initializeApp({
      projectId: PROJECT,
      databaseURL: RTDB ? `http://${RTDB}?ns=${PROJECT}-default-rtdb` : undefined,
    });
  }
  return admin.app();
}

describeE2E('Photo/Lifecycle Safety — 9-scenario emulator proof', () => {
  let db: admin.firestore.Firestore;
  let rtdb: admin.database.Database | null = null;
  let upsertDriverInvoice: any;
  let patchDriverInvoicePhotos: any;

  const driverAuth = {
    uid: 'uid-drv-1',
    token: { kind: 'driver', driverId: DRIVER_ID, companyId: COMPANY },
  };

  const otherDriverSameCompanyAuth = {
    uid: 'uid-drv-2',
    token: { kind: 'driver', driverId: OTHER_DRIVER_ID, companyId: COMPANY },
  };

  const otherCompanyDriverAuth = {
    uid: 'uid-other-co',
    token: { kind: 'driver', driverId: 'drv-foreign', companyId: OTHER_COMPANY },
  };

  const runCall = (fn: any, data: unknown, auth: unknown) =>
    fn.run({ data, auth, rawRequest: {} });

  beforeAll(() => {
    const app = initApp();
    db = app.firestore();
    if (RTDB) rtdb = app.database();

    // Import after admin is initialized
    const invoiceOps = require('../invoiceOps');
    upsertDriverInvoice = invoiceOps.upsertDriverInvoice;
    patchDriverInvoicePhotos = invoiceOps.patchDriverInvoicePhotos;
  });

  afterAll(async () => {
    if (rtdb) {
      try {
        rtdb.goOffline();
      } catch {}
    }
    if (db) {
      try {
        await db.terminate();
      } catch {}
    }
    await Promise.all(admin.apps.filter(Boolean).map((a) => a?.delete()));
  });

  beforeEach(async () => {
    if (rtdb) {
      await rtdb.ref(`drivers/profiles/${DRIVER_ID}`).set({
        active: true,
        companyId: COMPANY,
        displayName: 'Michael S24 Burger',
      });
      await rtdb.ref(`drivers/profiles/${OTHER_DRIVER_ID}`).set({
        active: true,
        companyId: COMPANY,
        displayName: 'Other Driver',
      });
      await rtdb.ref(`drivers/profiles/drv-foreign`).set({
        active: true,
        companyId: OTHER_COMPANY,
        displayName: 'Foreign Driver',
      });
    }
  });

  // ── Scenario 1: Active job remains active ─────────────────────────
  it('1. Active job remains active: photo patch leaves in_progress, no closedAt or completedAt', async () => {
    const docId = 'inv_test_scen1_active';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20300,
      status: 'in_progress',
      driverState: 'en_route',
      driverId: DRIVER_ID,
      companyId: COMPANY,
      wellName: 'Gab 1',
      bbls: 200,
    });

    const res: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          photos: [{ photoId: 'photo_scen1_1', remoteUrl: 'https://storage/p1.jpg' }],
        },
        intent: 'photo_patch',
        idempotencyKey: `photo_${docId}_1_photo_scen1_1`,
      },
      driverAuth,
    );

    expect(res.ok).toBe(true);
    expect(res.photoCount).toBe(1);

    const docSnap = await db.collection('invoices').doc(docId).get();
    const data = docSnap.data()!;

    expect(data.status).toBe('in_progress');
    expect(data.driverState).toBe('en_route');
    expect(data.closedAt).toBeUndefined();
    expect(data.completedAt).toBeUndefined();
    expect(data.ticketNumber).toBe(20300);
    expect(data.bbls).toBe(200);
    expect(data.photos).toHaveLength(1);
    expect(data.photos[0].photoId).toBe('photo_scen1_1');
  });

  // ── Scenario 2: Paused / back travel state preserved ──────────────
  it('2. Paused / back travel state preserved: leaves paused state untouched', async () => {
    const docId = 'inv_test_scen2_paused';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20302,
      status: 'in_progress',
      driverState: 'paused',
      driverId: DRIVER_ID,
      companyId: COMPANY,
      wellName: 'Gab 1',
    });

    const res: any = await runCall(
      patchDriverInvoicePhotos,
      {
        invoiceId: docId,
        photos: [{ photoId: 'photo_scen2_1', storagePath: 'invoices/p2.jpg' }],
        idempotencyKey: `photo_${docId}_1_photo_scen2_1`,
      },
      driverAuth,
    );

    expect(res.ok).toBe(true);

    const docSnap = await db.collection('invoices').doc(docId).get();
    const data = docSnap.data()!;

    expect(data.status).toBe('in_progress');
    expect(data.driverState).toBe('paused');
    expect(data.closedAt).toBeUndefined();
    expect(data.photos).toHaveLength(1);
    expect(data.photos[0].photoId).toBe('photo_scen2_1');
  });

  // ── Scenario 3: Multiple hauls / DDJD preserved ───────────────────
  it('3. Multiple hauls / DDJD preserved: haul 1 photo patch does not close haul 1 or corrupt haul 2', async () => {
    const haul1Id = 'inv_test_scen3_h1';
    const haul2Id = 'inv_test_scen3_h2';
    const groupId = 'hg_split_9988';

    await db.collection('invoices').doc(haul1Id).set({
      ticketNumber: 20303,
      status: 'in_progress',
      haulGroupId: groupId,
      haulIndex: 0,
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });
    await db.collection('invoices').doc(haul2Id).set({
      ticketNumber: 20304,
      status: 'in_progress',
      haulGroupId: groupId,
      haulIndex: 1,
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });

    const res: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: haul1Id,
        invoice: {
          photos: [{ photoId: 'photo_h1', storagePath: 'invoices/h1.jpg' }],
        },
        intent: 'photo_patch',
      },
      driverAuth,
    );

    expect(res.ok).toBe(true);

    const snap1 = await db.collection('invoices').doc(haul1Id).get();
    const snap2 = await db.collection('invoices').doc(haul2Id).get();

    expect(snap1.data()!.status).toBe('in_progress');
    expect(snap1.data()!.closedAt).toBeUndefined();
    expect(snap1.data()!.haulGroupId).toBe(groupId);
    expect(snap1.data()!.haulIndex).toBe(0);
    expect(snap1.data()!.photos).toHaveLength(1);

    expect(snap2.data()!.status).toBe('in_progress');
    expect(snap2.data()!.closedAt).toBeUndefined();
    expect(snap2.data()!.haulGroupId).toBe(groupId);
    expect(snap2.data()!.haulIndex).toBe(1);
  });

  // ── Scenario 4: Attempted lifecycle smuggling rejected ────────────
  it('4. Attempted lifecycle smuggling rejected: fails closed on status, closedAt, driverState', async () => {
    const docId = 'inv_test_scen4_smuggle';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20305,
      status: 'in_progress',
      driverState: 'en_route',
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });

    // 4a: Smuggling status: 'closed'
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: docId,
          invoice: {
            photos: [{ photoId: 'smuggle_1' }],
            status: 'closed',
          },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/forbidden in photo_patch/);

    // 4b: Smuggling closedAt
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: docId,
          invoice: {
            photos: [{ photoId: 'smuggle_2' }],
            closedAt: '2026-09-13T20:00:00Z',
          },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/forbidden in photo_patch/);

    // 4c: Smuggling driverState
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: docId,
          invoice: {
            photos: [{ photoId: 'smuggle_3' }],
            driverState: 'arrived',
          },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/forbidden in photo_patch/);

    // 4d: Smuggling closeReason
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: docId,
          invoice: {
            photos: [{ photoId: 'smuggle_4' }],
            closeReason: 'forced_close',
          },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/forbidden in photo_patch/);

    // Verify document in Firestore was NEVER mutated
    const snap = await db.collection('invoices').doc(docId).get();
    expect(snap.data()!.status).toBe('in_progress');
    expect(snap.data()!.driverState).toBe('en_route');
    expect(snap.data()!.closedAt).toBeUndefined();
    expect(snap.data()!.photos).toBeUndefined();
  });

  // ── Scenario 5: Metadata update accepted ──────────────────────────
  it('5. Metadata update accepted: photo array merges monotonically without duplicates', async () => {
    const docId = 'inv_test_scen5_merge';
    await db.collection('invoices').doc(docId).set({
      status: 'in_progress',
      driverId: DRIVER_ID,
      companyId: COMPANY,
      photos: [
        {
          photoId: 'photo_alpha',
          upload: { status: 'uploading' },
          takenAt: '2026-09-13T18:00:00Z',
        },
      ],
    });

    // Patch updates photo_alpha with remoteUrl and done, and adds photo_beta
    const res: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          photos: [
            {
              photoId: 'photo_alpha',
              upload: { status: 'done' },
              remoteUrl: 'https://storage/alpha.jpg',
              verdict: 'compliant',
            },
            {
              photoId: 'photo_beta',
              upload: { status: 'done' },
              remoteUrl: 'https://storage/beta.jpg',
            },
          ],
          photoMetadata: { lastReviewedBy: 'system' },
        },
        intent: 'photo_patch',
      },
      driverAuth,
    );

    expect(res.ok).toBe(true);
    expect(res.photoCount).toBe(2);

    const snap = await db.collection('invoices').doc(docId).get();
    const data = snap.data()!;

    expect(data.photos).toHaveLength(2);
    expect(data.photos[0].photoId).toBe('photo_alpha');
    expect(data.photos[0].upload.status).toBe('done');
    expect(data.photos[0].remoteUrl).toBe('https://storage/alpha.jpg');
    expect(data.photos[0].verdict).toBe('compliant');
    expect(data.photos[0].takenAt).toBe('2026-09-13T18:00:00Z'); // preserved!

    expect(data.photos[1].photoId).toBe('photo_beta');
    expect(data.photos[1].remoteUrl).toBe('https://storage/beta.jpg');
    expect(data.photoMetadata.lastReviewedBy).toBe('system');
  });

  // ── Scenario 6: Forged companyId / invalid docId rejected ─────────
  it('6. Forged companyId / invalid docId rejected', async () => {
    // 6a: Missing invoiceId
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: '',
          invoice: { photos: [] },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/invoiceId required/);

    // 6b: Non-existent invoiceId
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: 'non_existent_doc_123',
          invoice: { photos: [] },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/Invoice not found/);

    // 6c: Cross-company invoice
    const foreignDocId = 'inv_foreign_company';
    await db.collection('invoices').doc(foreignDocId).set({
      status: 'in_progress',
      driverId: 'foreign_drv',
      companyId: OTHER_COMPANY,
    });
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: foreignDocId,
          invoice: { photos: [] },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/Cross-company invoice/);

    // 6d: Invoice owned by another driver in same company
    const otherDrvDocId = 'inv_other_drv';
    await db.collection('invoices').doc(otherDrvDocId).set({
      status: 'in_progress',
      driverId: OTHER_DRIVER_ID,
      companyId: COMPANY,
    });
    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: otherDrvDocId,
          invoice: { photos: [] },
          intent: 'photo_patch',
        },
        driverAuth,
      ),
    ).rejects.toThrow(/owned by another driver/);
  });

  // ── Scenario 7: Explicit close still succeeds afterward ───────────
  it('7. Explicit close still succeeds afterward: transitions to closed with valid closedAt and retains photos', async () => {
    const docId = 'inv_test_scen7_flow';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20307,
      status: 'in_progress',
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });

    // Step 1: Photo patch
    const patchRes: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          photos: [{ photoId: 'flow_photo_1', remoteUrl: 'https://storage/flow1.jpg' }],
        },
        intent: 'photo_patch',
        idempotencyKey: `photo_${docId}_1_flow_photo_1`,
      },
      driverAuth,
    );
    expect(patchRes.ok).toBe(true);

    const snapMid = await db.collection('invoices').doc(docId).get();
    expect(snapMid.data()!.status).toBe('in_progress');
    expect(snapMid.data()!.closedAt).toBeUndefined();

    // Step 2: Explicit genuine close
    const closeRes: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          status: 'closed',
        },
        idempotencyKey: `close_${docId}`,
      },
      driverAuth,
    );
    expect(closeRes.ok).toBe(true);

    const snapFinal = await db.collection('invoices').doc(docId).get();
    const finalData = snapFinal.data()!;

    expect(finalData.status).toBe('closed');
    expect(finalData.closedAt).toBeDefined();
    expect(finalData.photos).toHaveLength(1);
    expect(finalData.photos[0].photoId).toBe('flow_photo_1');
  });

  // ── Scenario 8: Late photo retry on closed job does not corrupt or reopen ─
  it('8. Late photo retry on closed job does not corrupt or reopen the job', async () => {
    const docId = 'inv_test_scen8_late';
    const establishedClosedAt = admin.firestore.Timestamp.fromDate(new Date('2026-09-12T12:00:00Z'));

    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20308,
      status: 'closed',
      closedAt: establishedClosedAt,
      driverId: DRIVER_ID,
      companyId: COMPANY,
      photos: [{ photoId: 'early_photo', remoteUrl: 'https://storage/early.jpg' }],
    });

    const res: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          photos: [{ photoId: 'late_photo', remoteUrl: 'https://storage/late.jpg' }],
        },
        intent: 'photo_patch',
        idempotencyKey: `photo_${docId}_1_late_photo`,
      },
      driverAuth,
    );

    expect(res.ok).toBe(true);

    const snap = await db.collection('invoices').doc(docId).get();
    const data = snap.data()!;

    // Status remains closed
    expect(data.status).toBe('closed');
    // closedAt timestamp remains intact and unmodified
    expect(data.closedAt.toMillis()).toBe(establishedClosedAt.toMillis());
    // Both early and late photos are present
    expect(data.photos).toHaveLength(2);
    expect(data.photos[0].photoId).toBe('early_photo');
    expect(data.photos[1].photoId).toBe('late_photo');
  });

  // ── Scenario 9: Concurrency test ──────────────────────────────────
  it('9. Concurrency test: simultaneous photo patch and explicit close resolve deterministically', async () => {
    const docId = 'inv_test_scen9_concurrent';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20309,
      status: 'in_progress',
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });

    const photoPatchPromise = runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          photos: [{ photoId: 'concurrent_photo', remoteUrl: 'https://storage/concurrent.jpg' }],
        },
        intent: 'photo_patch',
        idempotencyKey: `photo_${docId}_1_concurrent_photo`,
      },
      driverAuth,
    );

    const explicitClosePromise = runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          status: 'closed',
          totalBBL: 180,
          intent: 'close',
        },
        idempotencyKey: `close_${docId}`,
      },
      driverAuth,
    );

    const [patchResult, closeResult]: any = await Promise.all([
      photoPatchPromise,
      explicitClosePromise,
    ]);

    expect(patchResult.ok).toBe(true);
    expect(closeResult.ok).toBe(true);

    const snap = await db.collection('invoices').doc(docId).get();
    const data = snap.data()!;

    expect(data.status).toBe('closed');
    expect(data.closedAt).toBeDefined();
    expect(data.photos).toHaveLength(1);
    expect(data.photos[0].photoId).toBe('concurrent_photo');
  });

  // ── Scenario 10: Installed vc103 backward containment ────────────────
  it('10. Installed vc103 backward containment: malformed legacy photo request does not close active invoice or poison idempotency', async () => {
    const docId = 'inv_test_scen10_vc103_legacy';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20310,
      status: 'in_progress',
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });

    // 1. Installed vc103 sends photo via legacy applyInvoiceCloseAtId:
    // normal upsert path, { photos, status: 'closed' }, close_${docId} key, NO intent field!
    const malformedLegacyResult: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          photos: [{ photoId: 'vc103_p1', remoteUrl: 'https://storage/vc103_p1.jpg' }],
          status: 'closed',
        },
        mode: 'upsert',
        idempotencyKey: `close_${docId}`,
      },
      driverAuth,
    );

    expect(malformedLegacyResult.ok).toBe(true);

    const snap1 = await db.collection('invoices').doc(docId).get();
    const data1 = snap1.data()!;

    // REQUIRED RESULT:
    // Invoice remains active!
    expect(data1.status).toBe('in_progress');
    // closedAt remains absent!
    expect(data1.closedAt).toBeUndefined();
    // Photos were successfully merged!
    expect(data1.photos).toHaveLength(1);
    expect(data1.photos[0].photoId).toBe('vc103_p1');

    // 2. Later, legitimate driver Close arrives with the same close_${docId} key:
    const genuineCloseResult: any = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: docId,
        invoice: {
          status: 'closed',
          totalBBL: 200,
          totalHours: 5,
          stopTime: '17:30',
          timeline: [{ type: 'depart', time: '17:30' }],
          intent: 'close',
        },
        mode: 'upsert',
        idempotencyKey: `close_${docId}`,
      },
      driverAuth,
    );

    expect(genuineCloseResult.ok).toBe(true);

    const snap2 = await db.collection('invoices').doc(docId).get();
    const data2 = snap2.data()!;

    // Legitimate Close successfully transitioned invoice to closed!
    expect(data2.status).toBe('closed');
    // closedAt is now stamped!
    expect(data2.closedAt).toBeDefined();
    // Photos remain intact!
    expect(data2.photos).toHaveLength(1);
    expect(data2.photos[0].photoId).toBe('vc103_p1');
    expect(data2.totalBBL).toBe(200);
  });

  // ── Scenario 11: Photo idempotency with updated accepted metadata and remote URL ──
  it('11. Photo idempotency accepts same photo ID when legitimate metadata or remote URL updates', async () => {
    const docId = 'inv_test_scen11_photo_idem';
    await db.collection('invoices').doc(docId).set({
      ticketNumber: 20311,
      status: 'in_progress',
      driverId: DRIVER_ID,
      companyId: COMPANY,
    });

    // 1. Initial photo patch with pending compliance and local/temporary storage URL
    const res1: any = await runCall(
      patchDriverInvoicePhotos,
      {
        invoiceId: docId,
        photos: [
          {
            photoId: 'photo_idem_test',
            remoteUrl: 'https://storage/initial_v1.jpg',
            compliance: { status: 'pending' },
            type: 'pickup',
          },
        ],
        idempotencyKey: `photo_${docId}_1_photo_idem_test`,
      },
      driverAuth,
    );
    expect(res1.ok).toBe(true);

    const snap1 = await db.collection('invoices').doc(docId).get();
    expect(snap1.data()!.photos).toHaveLength(1);
    expect(snap1.data()!.photos[0].remoteUrl).toBe('https://storage/initial_v1.jpg');
    expect(snap1.data()!.photos[0].compliance.status).toBe('pending');

    // 2. Updated photo patch with final remote URL and settled AI pass verdict
    const res2: any = await runCall(
      patchDriverInvoicePhotos,
      {
        invoiceId: docId,
        photos: [
          {
            photoId: 'photo_idem_test',
            remoteUrl: 'https://storage/final_v2.jpg',
            compliance: { status: 'pass', score: 98 },
            type: 'pickup',
          },
        ],
        idempotencyKey: `photo_${docId}_1_photo_idem_test_v2`,
      },
      driverAuth,
    );
    expect(res2.ok).toBe(true);

    const snap2 = await db.collection('invoices').doc(docId).get();
    const photos2 = snap2.data()!.photos;

    // Must NOT duplicate the photo entry
    expect(photos2).toHaveLength(1);
    // Must update the remoteUrl to the final URL
    expect(photos2[0].remoteUrl).toBe('https://storage/final_v2.jpg');
    // Must update the compliance metadata
    expect(photos2[0].compliance.status).toBe('pass');
    expect(photos2[0].compliance.score).toBe(98);
  });
});
