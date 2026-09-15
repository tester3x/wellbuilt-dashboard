/**
 * Real Firestore + RTDB emulator test suite for governed transfer request lifecycle.
 * Exercises createDriverTransferRequest, resolveTransferRequest, and acceptTransferRequest
 * against real emulator boundaries across all required safety scenarios.
 */
import * as admin from 'firebase-admin';

const FS = process.env.FIRESTORE_EMULATOR_HOST;
const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeE2E = FS ? describe : describe.skip;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-transfer-safety';

const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'acme-hauling';
const DRIVER_A_ID = 'drv-sender-a';
const DRIVER_B_ID = 'drv-receiver-b';
const DRIVER_FOREIGN_ID = 'drv-foreign-c';

function initApp(): admin.app.App {
  if (!admin.apps.length) {
    return admin.initializeApp({
      projectId: PROJECT,
      databaseURL: RTDB ? `http://${RTDB}?ns=${PROJECT}-default-rtdb` : undefined,
    });
  }
  return admin.app();
}

describeE2E('Governed Transfer Request Operations — Real Emulator E2E Suite', () => {
  let db: admin.firestore.Firestore;
  let rtdb: admin.database.Database;
  let createDriverTransferRequest: any;
  let resolveTransferRequest: any;
  let acceptTransferRequest: any;
  let upsertDriverInvoice: any;

  const authDriverA = {
    uid: 'uid-drv-a',
    token: { kind: 'driver', driverId: DRIVER_A_ID, companyId: COMPANY },
  };

  const authDriverB = {
    uid: 'uid-drv-b',
    token: { kind: 'driver', driverId: DRIVER_B_ID, companyId: COMPANY },
  };

  const authDriverForeign = {
    uid: 'uid-drv-foreign',
    token: { kind: 'driver', driverId: DRIVER_FOREIGN_ID, companyId: OTHER_COMPANY },
  };

  const runCall = (fn: any, data: unknown, auth: unknown) =>
    fn.run({ data, auth, rawRequest: {} });

  beforeAll(() => {
    const app = initApp();
    db = app.firestore();
    rtdb = app.database();

    const transferOps = require('../transferRequestOps');
    createDriverTransferRequest = transferOps.createDriverTransferRequest;
    resolveTransferRequest = transferOps.resolveTransferRequest;
    acceptTransferRequest = transferOps.acceptTransferRequest;

    const invoiceOps = require('../invoiceOps');
    upsertDriverInvoice = invoiceOps.upsertDriverInvoice;
  });

  afterAll(async () => {
    if (rtdb) {
      try { rtdb.goOffline(); } catch {}
    }
    if (db) {
      try { await db.terminate(); } catch {}
    }
    await Promise.all(admin.apps.filter(Boolean).map((a) => a?.delete()));
  });

  beforeEach(async () => {
    // Seed RTDB profiles
    await rtdb.ref(`drivers/profiles/${DRIVER_A_ID}`).set({
      active: true,
      companyId: COMPANY,
      displayName: 'Driver A Sender',
    });
    await rtdb.ref(`drivers/profiles/${DRIVER_B_ID}`).set({
      active: true,
      companyId: COMPANY,
      displayName: 'Driver B Receiver',
    });
    await rtdb.ref(`drivers/profiles/${DRIVER_FOREIGN_ID}`).set({
      active: true,
      companyId: OTHER_COMPANY,
      displayName: 'Foreign Driver C',
    });
  });

  // 1. Valid same-company owner request
  test('1. Valid same-company owner request atomically creates transfer request and locks invoice', async () => {
    const invId = 'inv-valid-1';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      wellName: 'FEDERAL 1-2-3H',
      operator: 'Oasis Petroleum',
      totalBBL: 180,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const res = await runCall(
      createDriverTransferRequest,
      {
        sourceInvoiceDocId: invId,
        toDriverHash: DRIVER_B_ID,
        mode: 'direct',
        reason: 'Handoff test',
      },
      authDriverA,
    );

    expect(res.ok).toBe(true);
    expect(res.requestId).toBeDefined();

    // Verify request doc
    const reqSnap = await db.collection('transfer_requests').doc(res.requestId).get();
    expect(reqSnap.exists).toBe(true);
    const reqData = reqSnap.data()!;
    expect(reqData.status).toBe('pending');
    expect(reqData.fromDriverHash).toBe(DRIVER_A_ID);
    expect(reqData.toDriverHash).toBe(DRIVER_B_ID);
    expect(reqData.toDriverName).toBe('Driver B Receiver');
    expect(reqData.companyId).toBe(COMPANY);
    expect(reqData.wellName).toBe('FEDERAL 1-2-3H');
    expect(reqData.totalBBL).toBe(180);

    // Verify invoice lock
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.activeTransferRequestId).toBe(res.requestId);
    expect(invSnap.data()!.lockedForTransfer).toBe(true);
  });

  // 2. Forged fromDriverHash
  test('2. Forged fromDriverHash fails closed with permission-denied', async () => {
    const invId = 'inv-forged-test';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          fromDriverHash: 'attacker-driver-hash',
          toDriverHash: DRIVER_B_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Actor identity mismatch/);
  });

  // 3. Invoice with missing owner
  test('3. Invoice with missing owner fails closed with permission-denied', async () => {
    const invId = 'inv-no-owner';
    await db.collection('invoices').doc(invId).set({
      companyId: COMPANY,
      status: 'open',
      // No driverId or driverHash
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_B_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Positive source-invoice ownership required/);

    // Verify no lock
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBeUndefined();
  });

  // 4. Another driver's invoice
  test('4. Another driver invoice fails closed with permission-denied', async () => {
    const invId = 'inv-driver-b-owned';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_B_ID,
      driverHash: DRIVER_B_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_B_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Invoice owned by another driver/);
  });

  // 5. Cross-company invoice
  test('5. Cross-company invoice fails closed with permission-denied', async () => {
    const invId = 'inv-cross-company';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      companyId: OTHER_COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_B_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Cross-company invoice transfer/);
  });

  // 6. Cross-company target
  test('6. Cross-company target driver fails closed with permission-denied', async () => {
    const invId = 'inv-valid-target-cross';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_FOREIGN_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Cross-company target driver/);
  });

  // 7. Missing/nonexistent target
  test('7. Missing or nonexistent target fails closed with not-found', async () => {
    const invId = 'inv-valid-ghost';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: 'drv-ghost-target',
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Target driver not found/);
  });

  // 8. Invalid mode
  test('8. Invalid mode fails closed with invalid-argument', async () => {
    const invId = 'inv-valid-mode-test';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_B_ID,
          mode: 'invalid_mode_str' as any,
        },
        authDriverA,
      ),
    ).rejects.toThrow(/mode must be "direct" or "approval"/);
  });

  // 9. Terminal invoice
  test('9. Terminal invoice (closed/void/cancelled) fails closed with failed-precondition', async () => {
    const invId = 'inv-closed-test';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'closed',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_B_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Cannot transfer terminal invoice/);
  });

  // 10. Already-locked invoice
  test('10. Already-locked invoice fails closed with failed-precondition', async () => {
    const invId = 'inv-locked-test';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      lockedForTransfer: true,
      activeTransferRequestId: 'existing-tr-1',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        {
          sourceInvoiceDocId: invId,
          toDriverHash: DRIVER_B_ID,
          mode: 'direct',
        },
        authDriverA,
      ),
    ).rejects.toThrow(/Invoice already locked for transfer/);
  });

  // 11. Duplicate identical retry
  test('11. Duplicate identical retry succeeds idempotently', async () => {
    const invId = 'inv-idemp-1';
    const reqId = 'tr-idemp-1';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    const first = await runCall(
      createDriverTransferRequest,
      {
        requestId: reqId,
        sourceInvoiceDocId: invId,
        toDriverHash: DRIVER_B_ID,
        mode: 'direct',
      },
      authDriverA,
    );
    expect(first.alreadyExisted).toBe(false);

    const retry = await runCall(
      createDriverTransferRequest,
      {
        requestId: reqId,
        sourceInvoiceDocId: invId,
        toDriverHash: DRIVER_B_ID,
        mode: 'direct',
      },
      authDriverA,
    );
    expect(retry.ok).toBe(true);
    expect(retry.alreadyExisted).toBe(true);
  });

  // 12. Duplicate request ID with different invoice or target
  test('12. Duplicate request ID with conflicting parameters throws already-exists', async () => {
    const invId1 = 'inv-conflict-1';
    const invId2 = 'inv-conflict-2';
    const reqId = 'tr-conflict-key';
    await db.collection('invoices').doc(invId1).set({ driverId: DRIVER_A_ID, companyId: COMPANY, status: 'open' });
    await db.collection('invoices').doc(invId2).set({ driverId: DRIVER_A_ID, companyId: COMPANY, status: 'open' });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId1, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Attempt reuse with invId2
    await expect(
      runCall(
        createDriverTransferRequest,
        { requestId: reqId, sourceInvoiceDocId: invId2, toDriverHash: DRIVER_B_ID, mode: 'direct' },
        authDriverA,
      ),
    ).rejects.toThrow(/Transfer request already exists with conflicting parameters/);
  });

  // 13. Transaction failure leaves no request and no lock
  test('13. Transaction failure leaves no request doc and no invoice lock', async () => {
    const nonExistentInvId = 'inv-nonexistent-999';
    const reqId = 'tr-aborted-1';

    await expect(
      runCall(
        createDriverTransferRequest,
        { requestId: reqId, sourceInvoiceDocId: nonExistentInvId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
        authDriverA,
      ),
    ).rejects.toThrow(/not found/);

    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.exists).toBe(false);
  });

  // 14. Cancel clears the lock
  test('14. Sender cancel clears invoice lock and marks request cancelled', async () => {
    const invId = 'inv-cancel-test';
    const reqId = 'tr-cancel-test';
    await db.collection('invoices').doc(invId).set({ driverId: DRIVER_A_ID, companyId: COMPANY, status: 'open' });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Cancel by sender
    const cancelRes = await runCall(
      resolveTransferRequest,
      { requestId: reqId, action: 'cancel', reason: 'Driver cancelled' },
      authDriverA,
    );
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.status).toBe('cancelled');

    // Verify invoice lock cleared
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(false);
    expect(invSnap.data()!.activeTransferRequestId).toBeUndefined();

    // Verify request is cancelled
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.data()!.status).toBe('cancelled');
    expect(reqSnap.data()!.terminalBy).toBe(DRIVER_A_ID);
  });

  // 15. Accept transfers to Driver B and creates/updates target dispatch
  test('15. Receiver accept transfers ownership to Driver B and assigns dispatch', async () => {
    const invId = 'inv-accept-test';
    const reqId = 'tr-accept-test';
    const dispId = 'disp-accept-test';

    await db.collection('dispatches').doc(dispId).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      driverName: 'Driver A Sender',
      companyId: COMPANY,
      status: 'assigned',
      wellName: 'BIG HORN 4-5H',
    });

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      driver: 'Driver A Sender',
      companyId: COMPANY,
      status: 'open',
      dispatchId: dispId,
      wellName: 'BIG HORN 4-5H',
      timeline: [{ type: 'depart', timestamp: '2026-09-14T10:00:00Z' }],
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Receiver accepts
    const acceptRes = await runCall(
      acceptTransferRequest,
      { requestId: reqId, truckNumber: 'TRK-99', trailer: 'TRL-88' },
      authDriverB,
    );
    expect(acceptRes.ok).toBe(true);

    // Verify invoice ownership flipped to Driver B
    const invSnap = await db.collection('invoices').doc(invId).get();
    const invData = invSnap.data()!;
    expect(invData.driverId).toBe(DRIVER_B_ID);
    expect(invData.driverHash).toBe(DRIVER_B_ID);
    expect(invData.driver).toBe('Driver B Receiver');
    expect(invData.truckNumber).toBe('TRK-99');
    expect(invData.driverState).toBe('en_route_handoff');
    expect(invData.lockedForTransfer).toBe(false);
    expect(invData.activeTransferRequestId).toBeUndefined();

    // Verify timeline appended
    expect(invData.timeline.some((e: any) => e.type === 'handoff_pickup_start')).toBe(true);

    // Verify dispatch flipped to Driver B
    const dispSnap = await db.collection('dispatches').doc(dispId).get();
    const dispData = dispSnap.data()!;
    expect(dispData.driverId).toBe(DRIVER_B_ID);
    expect(dispData.driverHash).toBe(DRIVER_B_ID);
    expect(dispData.driverName).toBe('Driver B Receiver');
    expect(dispData.transferredFromHash).toBe(DRIVER_A_ID);

    // Verify transfer request marked accepted
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.data()!.status).toBe('accepted');
    expect(reqSnap.data()!.terminalBy).toBe(DRIVER_B_ID);
  });

  // 16. Driver A can no longer mutate ownership afterward
  test('16. Driver A cannot mutate or reclaim invoice ownership after transfer is accepted', async () => {
    const invId = 'inv-accept-test'; // from test 15, now owned by Driver B

    await expect(
      runCall(
        upsertDriverInvoice,
        {
          invoiceId: invId,
          invoice: { driver: 'Driver A Sender', driverId: DRIVER_A_ID },
        },
        authDriverA,
      ),
    ).rejects.toThrow();

    // Invoice remains owned by Driver B
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.driverId).toBe(DRIVER_B_ID);
  });

  // 17. No orphan lock or request under any failure
  test('17. No orphan lock or request exists across rejected actions', async () => {
    const invId = 'inv-orphan-proof';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    // Failing attempt: non-existent target
    await expect(
      runCall(
        createDriverTransferRequest,
        { sourceInvoiceDocId: invId, toDriverHash: 'drv-unknown-99', mode: 'direct' },
        authDriverA,
      ),
    ).rejects.toThrow();

    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBeFalsy();
    expect(invSnap.data()!.activeTransferRequestId).toBeUndefined();
  });
});
