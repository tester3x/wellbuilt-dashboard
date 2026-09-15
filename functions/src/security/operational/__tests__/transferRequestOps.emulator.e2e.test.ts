/**
 * Real Firestore + RTDB emulator test suite for governed transfer request lifecycle.
 * Exercises createDriverTransferRequest, resolveTransferRequest, and acceptTransferRequest
 * against real emulator boundaries across all required safety scenarios.
 */
import * as admin from 'firebase-admin';
import { runTransferRequestExpiry } from '../../../transfer-request-expiry';

const FS = process.env.FIRESTORE_EMULATOR_HOST;
const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeE2E = FS ? describe : describe.skip;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-transfer-safety';

const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'acme-hauling';
const DRIVER_A_ID = 'drv-sender-a';
const DRIVER_B_ID = 'drv-receiver-b';
const DRIVER_C_ID = 'drv-thirdparty-c';
const DRIVER_DISP_ID = 'drv-dispatcher-staff';
const DRIVER_FOREIGN_ID = 'drv-foreign-f';

const DRIVER_A_LEGACY_KEY = 'legacy-approved-key-a123';

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
  let upsertDriverDispatch: any;

  const authDriverA = {
    uid: 'uid-drv-a',
    token: { kind: 'driver', driverId: DRIVER_A_ID, companyId: COMPANY, roles: ['driver'] },
  };

  const authDriverB = {
    uid: 'uid-drv-b',
    token: { kind: 'driver', driverId: DRIVER_B_ID, companyId: COMPANY, roles: ['driver'] },
  };

  const authDriverC = {
    uid: 'uid-drv-c',
    token: { kind: 'driver', driverId: DRIVER_C_ID, companyId: COMPANY, roles: ['driver'] },
  };

  const authDispatcher = {
    uid: 'uid-dispatcher',
    token: { kind: 'driver', driverId: DRIVER_DISP_ID, companyId: COMPANY, roles: ['dispatcher'] },
  };

  const authDriverForeign = {
    uid: 'uid-drv-foreign',
    token: { kind: 'driver', driverId: DRIVER_FOREIGN_ID, companyId: OTHER_COMPANY, roles: ['driver'] },
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
    upsertDriverDispatch = invoiceOps.upsertDriverDispatch;
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
    await rtdb.ref(`drivers/profiles/${DRIVER_C_ID}`).set({
      active: true,
      companyId: COMPANY,
      displayName: 'Driver C Peer',
    });
    await rtdb.ref(`drivers/profiles/${DRIVER_DISP_ID}`).set({
      active: true,
      companyId: COMPANY,
      displayName: 'Dispatcher Staff',
      roles: ['dispatcher'],
    });
    await rtdb.ref(`drivers/profiles/${DRIVER_FOREIGN_ID}`).set({
      active: true,
      companyId: OTHER_COMPANY,
      displayName: 'Foreign Driver F',
    });

    // Seed identity binding for Driver A's legacy key
    await rtdb.ref(`drivers/identityBindings/byDriver/${DRIVER_A_ID}`).set({
      driverId: DRIVER_A_ID,
      approvedKey: DRIVER_A_LEGACY_KEY,
      status: 'active',
      opId: 'seed-op-1',
    });
    await rtdb.ref(`drivers/identityBindings/byApproved/${DRIVER_A_LEGACY_KEY}`).set({
      driverId: DRIVER_A_ID,
      approvedKey: DRIVER_A_LEGACY_KEY,
      status: 'active',
      opId: 'seed-op-1',
    });
    await rtdb.ref(`drivers/approved/${DRIVER_A_LEGACY_KEY}`).set({
      active: true,
      companyId: COMPANY,
      displayName: 'Driver A Sender Legacy',
      migratedToDriverId: DRIVER_A_ID,
    });
  });

  // Scenario 1: Direct accept with existing dispatch
  test('1. Successful direct accept with existing dispatch transfers ownership atomically', async () => {
    const invId = 'inv-scen-1';
    const reqId = 'tr-scen-1';
    const dispId = 'disp-scen-1';

    await db.collection('dispatches').doc(dispId).set({
      id: dispId,
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      driverName: 'Driver A Sender',
      companyId: COMPANY,
      status: 'assigned',
      wellName: 'WELL-ALPHA 1H',
      operator: 'Oasis Petroleum',
    });

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      driver: 'Driver A Sender',
      companyId: COMPANY,
      status: 'open',
      dispatchId: dispId,
      wellName: 'WELL-ALPHA 1H',
      operator: 'Oasis Petroleum',
      timeline: [{ type: 'depart', timestamp: '2026-09-14T10:00:00Z' }],
    });

    const createRes = await runCall(
      createDriverTransferRequest,
      {
        requestId: reqId,
        sourceInvoiceDocId: invId,
        toDriverHash: DRIVER_B_ID,
        mode: 'direct',
        reason: 'Shift end handoff',
        fromGpsLat: 31.8456,
        fromGpsLng: -102.3678,
      },
      authDriverA,
    );
    expect(createRes.ok).toBe(true);

    // Receiver accepts with GPS and truck/trailer
    const acceptRes = await runCall(
      acceptTransferRequest,
      {
        requestId: reqId,
        acceptGpsLat: 31.846,
        acceptGpsLng: -102.368,
        truckNumber: 'TRK-101',
        trailer: 'TRL-202',
      },
      authDriverB,
    );
    expect(acceptRes.ok).toBe(true);
    expect(acceptRes.targetDispatchId).toBe(dispId);

    // Verify invoice ownership
    const invSnap = await db.collection('invoices').doc(invId).get();
    const invData = invSnap.data()!;
    expect(invData.driverId).toBe(DRIVER_B_ID);
    expect(invData.driverHash).toBe(DRIVER_B_ID);
    expect(invData.driver).toBe('Driver B Receiver');
    expect(invData.dispatchId).toBe(dispId);
    expect(invData.truckNumber).toBe('TRK-101');
    expect(invData.trailer).toBe('TRL-202');
    expect(invData.driverState).toBe('en_route_handoff');
    expect(invData.lockedForTransfer).toBe(false);
    expect(invData.activeTransferRequestId).toBeUndefined();
    expect(invData.timeline.some((e: any) => e.type === 'handoff_pickup_start')).toBe(true);

    // Verify existing dispatch updated
    const dispSnap = await db.collection('dispatches').doc(dispId).get();
    const dispData = dispSnap.data()!;
    expect(dispData.driverId).toBe(DRIVER_B_ID);
    expect(dispData.driverHash).toBe(DRIVER_B_ID);
    expect(dispData.driverName).toBe('Driver B Receiver');
    expect(dispData.transferredFromHash).toBe(DRIVER_A_ID);

    // Verify request doc
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.data()!.status).toBe('accepted');
    expect(reqSnap.data()!.terminalBy).toBe(DRIVER_B_ID);
    expect(reqSnap.data()!.targetDispatchId).toBe(dispId);
  });

  // Scenario 2: Canonical dispatch creation & downstream lifecycle
  test('2. Canonical dispatch creation when accepting transfer without existing dispatch and downstream lifecycle verification', async () => {
    const invId = 'inv-scen-2';
    const reqId = 'tr-scen-2';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_ID,
      driver: 'Driver A Sender',
      companyId: COMPANY,
      status: 'open',
      wellName: 'BULLDOG 12-1H',
      operator: 'Devon Energy',
      totalBBL: 190,
      canonicalJobId: 'job-can-99',
      haulGroupId: 'haul-group-88',
      packetId: 'pkt-source-77',
      tickets: ['tkt-1', 'tkt-2'],
      ticketNumber: 'TK-445566',
      invoicingMode: 'split_haul',
    });

    await runCall(
      createDriverTransferRequest,
      {
        requestId: reqId,
        sourceInvoiceDocId: invId,
        toDriverHash: DRIVER_B_ID,
        mode: 'direct',
      },
      authDriverA,
    );

    const acceptRes = await runCall(
      acceptTransferRequest,
      { requestId: reqId },
      authDriverB,
    );
    expect(acceptRes.ok).toBe(true);
    const targetDispatchId = acceptRes.targetDispatchId;
    expect(targetDispatchId).toBeDefined();

    // Verify canonical dispatch ID is persisted on request doc
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.data()!.targetDispatchId).toBe(targetDispatchId);

    // Verify canonical dispatch ID is persisted on invoice doc
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.dispatchId).toBe(targetDispatchId);
    expect(invSnap.data()!.driverId).toBe(DRIVER_B_ID);

    // Verify newly created dispatch in Firestore
    const newDispSnap = await db.collection('dispatches').doc(targetDispatchId).get();
    expect(newDispSnap.exists).toBe(true);
    const d = newDispSnap.data()!;
    expect(d.id).toBe(targetDispatchId);
    expect(d.type).toBe('transfer');
    expect(d.driverId).toBe(DRIVER_B_ID);
    expect(d.driverHash).toBe(DRIVER_B_ID);
    expect(d.driverName).toBe('Driver B Receiver');
    expect(d.companyId).toBe(COMPANY);
    expect(d.status).toBe('assigned');
    expect(d.assignedBy).toBe('transfer');
    expect(d.wellName).toBe('BULLDOG 12-1H');
    expect(d.operator).toBe('Devon Energy');
    expect(d.canonicalJobId).toBe('job-can-99');
    expect(d.sourceMultiHaulId).toBe('haul-group-88');
    expect(d.sourcePacketId).toBe('pkt-source-77');
    expect(d.ticketDocIds).toEqual(['tkt-1', 'tkt-2']);
    expect(d.ticketNumber).toBe('TK-445566');
    expect(d.invoicingMode).toBe('split_haul');
    expect(d.transferredFromHash).toBe(DRIVER_A_ID);
    expect(d.transferFromDriverHash).toBe(DRIVER_A_ID);
    expect(d.sourceInvoiceDocId).toBe(invId);
    expect(d.transferRequestId).toBe(reqId);

    // Downstream lifecycle verification:
    // Driver B updates the invoice via upsertDriverInvoice
    const invUpdateRes = await runCall(
      upsertDriverInvoice,
      {
        invoiceId: invId,
        invoice: {
          currentStage: 'loading',
          notes: 'Driver B proceeding with load',
        },
      },
      authDriverB,
    );
    expect(invUpdateRes.ok).toBe(true);

    // Driver B updates the dispatch via upsertDriverDispatch
    const dispUpdateRes = await runCall(
      upsertDriverDispatch,
      {
        dispatchId: targetDispatchId,
        dispatch: {
          status: 'in_progress',
        },
      },
      authDriverB,
    );
    expect(dispUpdateRes.ok).toBe(true);

    // Assert that no second dispatch/job was manufactured
    const matchingDispatches = await db
      .collection('dispatches')
      .where('sourceInvoiceDocId', '==', invId)
      .get();
    expect(matchingDispatches.docs.length).toBe(1);
    expect(matchingDispatches.docs[0].id).toBe(targetDispatchId);
    expect(matchingDispatches.docs[0].data()!.status).toBe('in_progress');
  });

  // Scenario 3: Read-before-write compliance
  test('3. Firestore transaction strictly complies with read-before-write ordering', async () => {
    const invId = 'inv-scen-3';
    const reqId = 'tr-scen-3';
    const dispId = 'disp-scen-3';

    await db.collection('dispatches').doc(dispId).set({
      id: dispId,
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'assigned',
      sourceInvoiceDocId: invId,
    });

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      dispatchId: dispId,
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // This must execute cleanly without Firestore throwing read-after-write errors
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverB),
    ).resolves.toMatchObject({ ok: true });
  });

  // Scenario 4: Wrong driver accept/decline in direct mode
  test('4. Wrong driver accept, decline, or cancel fails closed with permission-denied', async () => {
    const invId = 'inv-scen-4';
    const reqId = 'tr-scen-4';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Driver C (same company, third party) tries to accept
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverC),
    ).rejects.toThrow(/Only requested recipient can accept this transfer/);

    // Privileged staff who is not Driver B tries to accept: must fail closed, staff does not become owner!
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDispatcher),
    ).rejects.toThrow(/Only requested recipient can accept this transfer/);

    // Driver C tries to decline
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'decline' }, authDriverC),
    ).rejects.toThrow(/Only requested recipient can decline this transfer/);

    // Driver B (recipient) tries to cancel
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'cancel' }, authDriverB),
    ).rejects.toThrow(/Only sender can cancel this transfer request/);

    // Request is still pending and invoice is still locked by Driver A
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.data()!.status).toBe('pending');
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(true);
    expect(invSnap.data()!.driverId).toBe(DRIVER_A_ID);
  });

  // Scenario 5: Approval-mode fail-closed authority matrix
  test('5. Approval-mode authority matrix: fails closed on accept/decline; sender cancel succeeds; owner remains Driver A', async () => {
    const invId = 'inv-scen-5';
    const reqId = 'tr-scen-5';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, mode: 'approval' },
      authDriverA,
    );

    // Matrix test 1: Driver B tries to accept -> fails closed with failed-precondition
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverB),
    ).rejects.toThrow(/Approval-mode transfer requests are pending governed dispatch approval workflow and cannot be accepted directly/);

    // Matrix test 2: Driver C (unrelated peer) tries to accept -> fails closed
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverC),
    ).rejects.toThrow(/Approval-mode transfer requests are pending governed dispatch approval workflow and cannot be accepted directly/);

    // Matrix test 3: Privileged staff tries to accept -> fails closed (staff does NOT become owner!)
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDispatcher),
    ).rejects.toThrow(/Approval-mode transfer requests are pending governed dispatch approval workflow and cannot be accepted directly/);

    // Matrix test 4: Driver B tries to decline -> fails closed
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'decline' }, authDriverB),
    ).rejects.toThrow(/Approval-mode transfer requests cannot be declined by driver/);

    // Matrix test 5: Privileged staff tries to decline -> fails closed
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'decline' }, authDispatcher),
    ).rejects.toThrow(/Approval-mode transfer requests cannot be declined by driver/);

    // Verify invoice remains locked and owned by Driver A
    const midInv = await db.collection('invoices').doc(invId).get();
    expect(midInv.data()!.driverId).toBe(DRIVER_A_ID);
    expect(midInv.data()!.lockedForTransfer).toBe(true);

    // Matrix test 6: Sender Driver A cancels approval request -> SUCCEEDS
    const cancelRes = await runCall(
      resolveTransferRequest,
      { requestId: reqId, action: 'cancel', reason: 'Sender cancelled approval transfer' },
      authDriverA,
    );
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.status).toBe('cancelled');

    // Resulting owner remains Driver A and invoice lock is released
    const finalInv = await db.collection('invoices').doc(invId).get();
    expect(finalInv.data()!.driverId).toBe(DRIVER_A_ID);
    expect(finalInv.data()!.lockedForTransfer).toBe(false);
    expect(finalInv.data()!.activeTransferRequestId).toBeUndefined();
  });

  // Scenario 6: Strict expiry authorization matrix
  test('6. Expiry authorization: unrelated driver before/after TTL denied; privileged staff before TTL denied; privileged staff after TTL succeeds; scheduled expiry succeeds', async () => {
    // Part A: Request with future TTL
    const invIdFuture = 'inv-scen-6-future';
    const reqIdFuture = 'tr-scen-6-future';

    await db.collection('invoices').doc(invIdFuture).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqIdFuture, sourceInvoiceDocId: invIdFuture, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Test 6.1: Unrelated same-company driver before TTL -> denied, zero mutation
    await expect(
      runCall(resolveTransferRequest, { requestId: reqIdFuture, action: 'expire' }, authDriverC),
    ).rejects.toThrow(/Ordinary drivers are not authorized to expire transfer requests/);

    // Test 6.2: Privileged staff before TTL -> denied, zero mutation
    await expect(
      runCall(resolveTransferRequest, { requestId: reqIdFuture, action: 'expire' }, authDispatcher),
    ).rejects.toThrow(/Transfer request TTL has not expired yet/);

    // Verify zero mutation on future request
    let reqSnap = await db.collection('transfer_requests').doc(reqIdFuture).get();
    expect(reqSnap.data()!.status).toBe('pending');
    let invSnap = await db.collection('invoices').doc(invIdFuture).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(true);

    // Part B: Request with expired TTL (set 10 seconds in past)
    const invIdPast = 'inv-scen-6-past';
    const reqIdPast = 'tr-scen-6-past';

    await db.collection('invoices').doc(invIdPast).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      activeTransferRequestId: reqIdPast,
      lockedForTransfer: true,
    });

    const pastTimestamp = admin.firestore.Timestamp.fromMillis(Date.now() - 10000);
    await db.collection('transfer_requests').doc(reqIdPast).set({
      id: reqIdPast,
      sourceInvoiceDocId: invIdPast,
      fromDriverHash: DRIVER_A_ID,
      toDriverHash: DRIVER_B_ID,
      mode: 'direct',
      status: 'pending',
      companyId: COMPANY,
      ttlExpiresAt: pastTimestamp,
    });

    // Test 6.3: Unrelated same-company driver after TTL -> still denied, zero mutation!
    await expect(
      runCall(resolveTransferRequest, { requestId: reqIdPast, action: 'expire' }, authDriverC),
    ).rejects.toThrow(/Ordinary drivers are not authorized to expire transfer requests/);

    // Test 6.4: Privileged staff after TTL -> SUCCEEDS!
    const staffExpireRes = await runCall(
      resolveTransferRequest,
      { requestId: reqIdPast, action: 'expire', reason: 'Expired by staff after TTL' },
      authDispatcher,
    );
    expect(staffExpireRes.ok).toBe(true);
    expect(staffExpireRes.status).toBe('expired');

    // Verify request marked expired and invoice unlocked
    reqSnap = await db.collection('transfer_requests').doc(reqIdPast).get();
    expect(reqSnap.data()!.status).toBe('expired');
    expect(reqSnap.data()!.terminalBy).toBe(DRIVER_DISP_ID);
    invSnap = await db.collection('invoices').doc(invIdPast).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(false);
    expect(invSnap.data()!.activeTransferRequestId).toBeUndefined();

    // Part C: Governed scheduled expiry cron (transfer-request-expiry.ts)
    const invIdCron = 'inv-scen-6-cron';
    const reqIdCron = 'tr-scen-6-cron';
    await db.collection('invoices').doc(invIdCron).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      activeTransferRequestId: reqIdCron,
      lockedForTransfer: true,
    });
    await db.collection('transfer_requests').doc(reqIdCron).set({
      id: reqIdCron,
      sourceInvoiceDocId: invIdCron,
      fromDriverHash: DRIVER_A_ID,
      toDriverHash: DRIVER_B_ID,
      mode: 'direct',
      status: 'pending',
      companyId: COMPANY,
      ttlExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 20000),
    });

    // Run scheduled expiry
    const cronResult = await runTransferRequestExpiry(10);
    expect(cronResult.expired.some((e) => e.requestId === reqIdCron)).toBe(true);

    // Verify cron expired request and cleared invoice lock
    reqSnap = await db.collection('transfer_requests').doc(reqIdCron).get();
    expect(reqSnap.data()!.status).toBe('expired');
    expect(reqSnap.data()!.terminalBy).toBe('system');
    invSnap = await db.collection('invoices').doc(invIdCron).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(false);
    expect(invSnap.data()!.activeTransferRequestId).toBeNull();
  });

  // Scenario 7: Missing and cross-company request/invoice/dispatch
  test('7. Missing and cross-company request, invoice, or dispatch fails closed', async () => {
    // Non-existent request ID
    await expect(
      runCall(resolveTransferRequest, { requestId: 'tr-nonexistent-7', action: 'cancel' }, authDriverA),
    ).rejects.toThrow(/not found/);

    // Cross-company transfer request
    const invId = 'inv-scen-7-cross';
    const reqId = 'tr-scen-7-cross';
    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });
    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Foreign driver attempts to accept
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverForeign),
    ).rejects.toThrow(/Cross-company transfer accept denied/);

    // Foreign driver attempts to resolve
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'cancel' }, authDriverForeign),
    ).rejects.toThrow(/Cross-company transfer resolution denied/);
  });

  // Scenario 8: Invoice owner mismatch vs legitimate legacy aliases
  test('8. Legitimate RTDB alias owner succeeds; true conflicting driver owner fails closed', async () => {
    // Case 8A: Legitimate alias (driverId is UUID, driverHash is legacy approved key linked in RTDB)
    const invId8A = 'inv-scen-8-alias';
    const reqId8A = 'tr-scen-8-alias';
    await db.collection('invoices').doc(invId8A).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_A_LEGACY_KEY,
      companyId: COMPANY,
      status: 'open',
    });

    // Driver A creates transfer request: legitimate alias must succeed
    const res8A = await runCall(
      createDriverTransferRequest,
      { requestId: reqId8A, sourceInvoiceDocId: invId8A, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );
    expect(res8A.ok).toBe(true);

    // Case 8B: Conflicting owner (driverId is Driver A, driverHash is Driver B - conflicting drivers)
    const invId8B = 'inv-scen-8-conflict';
    const reqId8B = 'tr-scen-8-conflict';
    await db.collection('invoices').doc(invId8B).set({
      driverId: DRIVER_A_ID,
      driverHash: DRIVER_B_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await expect(
      runCall(
        createDriverTransferRequest,
        { requestId: reqId8B, sourceInvoiceDocId: invId8B, toDriverHash: DRIVER_B_ID, mode: 'direct' },
        authDriverA,
      ),
    ).rejects.toThrow(/Ambiguous source-invoice ownership/);
  });

  // Scenario 9: Terminal invoice
  test('9. Terminal invoice rejected on create and accept', async () => {
    const invClosed = 'inv-scen-9-closed';
    await db.collection('invoices').doc(invClosed).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'closed',
    });

    // Create fails on terminal invoice
    await expect(
      runCall(
        createDriverTransferRequest,
        { sourceInvoiceDocId: invClosed, toDriverHash: DRIVER_B_ID, mode: 'direct' },
        authDriverA,
      ),
    ).rejects.toThrow(/Cannot transfer terminal invoice/);

    // If invoice is marked closed while request is pending:
    const invPending = 'inv-scen-9-race-closed';
    const reqId = 'tr-scen-9-race';
    await db.collection('invoices').doc(invPending).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });
    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invPending, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Close invoice directly (simulating close before accept)
    await db.collection('invoices').doc(invPending).update({ status: 'completed' });

    // Accept must fail closed
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverB),
    ).rejects.toThrow(/Cannot accept transfer for terminal invoice/);
  });

  // Scenario 10: Wrong active lock ID
  test('10. Invoice locked by different request ID cannot be accepted or re-requested; lock ownership is strictly preserved', async () => {
    const invId = 'inv-scen-10-lock';
    const reqId = 'tr-scen-10-req';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      lockedForTransfer: true,
      activeTransferRequestId: 'foreign-lock-999',
    });

    // Create fails on already locked
    await expect(
      runCall(
        createDriverTransferRequest,
        { sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
        authDriverA,
      ),
    ).rejects.toThrow(/Invoice already locked for transfer/);

    // Set up request doc pointing to this invoice
    await db.collection('transfer_requests').doc(reqId).set({
      id: reqId,
      sourceInvoiceDocId: invId,
      fromDriverHash: DRIVER_A_ID,
      toDriverHash: DRIVER_B_ID,
      mode: 'direct',
      status: 'pending',
      companyId: COMPANY,
    });

    // Accept fails because invoice activeTransferRequestId is not reqId
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverB),
    ).rejects.toThrow(/Invoice is not locked for this transfer request/);

    // Sender cancels reqId: request is cancelled, but foreign-lock-999 on invoice is NOT cleared!
    const cancelRes = await runCall(
      resolveTransferRequest,
      { requestId: reqId, action: 'cancel' },
      authDriverA,
    );
    expect(cancelRes.ok).toBe(true);

    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(true);
    expect(invSnap.data()!.activeTransferRequestId).toBe('foreign-lock-999');
  });

  // Scenario 11: Unauthorized terminal cleanup
  test('11. Unauthorized driver calling resolve on terminal request is rejected before any cleanup', async () => {
    const invId = 'inv-scen-11';
    const reqId = 'tr-scen-11';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Sender cancels legitimate request
    await runCall(resolveTransferRequest, { requestId: reqId, action: 'cancel' }, authDriverA);

    // Foreign driver attempts to call resolveTransferRequest on already-cancelled request
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'cancel' }, authDriverForeign),
    ).rejects.toThrow(/Cross-company transfer resolution denied/);

    // Unauthorized driver C (same company, not sender/recipient) attempts to call resolveTransferRequest
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'cancel' }, authDriverC),
    ).rejects.toThrow(/Only sender can cancel this transfer request/);
  });

  // Scenario 12: Same-recipient retry
  test('12. Same-recipient accept retry returns already-accepted canonical result without mutation', async () => {
    const invId = 'inv-scen-12';
    const reqId = 'tr-scen-12';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // First accept
    const firstAccept = await runCall(
      acceptTransferRequest,
      { requestId: reqId, truckNumber: 'TRK-ORIG' },
      authDriverB,
    );
    expect(firstAccept.ok).toBe(true);
    expect(firstAccept.alreadyAccepted).toBeUndefined();

    // Second accept (network retry) by same recipient
    const retryAccept = await runCall(
      acceptTransferRequest,
      { requestId: reqId, truckNumber: 'TRK-RETRY' },
      authDriverB,
    );
    expect(retryAccept.ok).toBe(true);
    expect(retryAccept.alreadyAccepted).toBe(true);
    expect(retryAccept.sourceInvoiceDocId).toBe(invId);

    // Verify invoice wasn't mutated on retry
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.truckNumber).toBe('TRK-ORIG');
  });

  // Scenario 13: Conflicting retry
  test('13. Conflicting accept retry by different driver fails without mutation', async () => {
    const invId = 'inv-scen-13';
    const reqId = 'tr-scen-13';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    // Driver B accepts
    await runCall(acceptTransferRequest, { requestId: reqId }, authDriverB);

    // Driver C attempts to accept already-accepted request
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverC),
    ).rejects.toThrow(/Transfer request already accepted by another driver/);

    // Invoice remains owned by Driver B
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.driverId).toBe(DRIVER_B_ID);
  });

  // Scenario 14: Canonical identity preservation
  test('14. Canonical identity fields preserved across transfer creation and dispatch creation', async () => {
    const invId = 'inv-scen-14';
    const reqId = 'tr-scen-14';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      wellName: 'EAGLE 4-5H',
      operator: 'ConocoPhillips',
      totalBBL: 215,
      canonicalJobId: 'canon-job-xyz',
      haulGroupId: 'multi-haul-123',
      packetId: 'pkt-original-456',
      tickets: ['ticket-doc-1', 'ticket-doc-2'],
      ticketNumber: 998877,
      invoicingMode: 'standard',
    });

    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'direct' },
      authDriverA,
    );

    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    const rd = reqSnap.data()!;
    expect(rd.canonicalJobId).toBe('canon-job-xyz');
    expect(rd.sourceMultiHaulId).toBe('multi-haul-123');
    expect(rd.sourcePacketId).toBe('pkt-original-456');
    expect(rd.sourceTicketDocIds).toEqual(['ticket-doc-1', 'ticket-doc-2']);
    expect(rd.sourceTicketNumber).toBe(998877);
    expect(rd.sourceInvoicingMode).toBe('standard');
    expect(rd.totalBBL).toBe(215);

    const acceptRes = await runCall(acceptTransferRequest, { requestId: reqId }, authDriverB);
    const dispSnap = await db.collection('dispatches').doc(acceptRes.targetDispatchId).get();
    const dd = dispSnap.data()!;
    expect(dd.canonicalJobId).toBe('canon-job-xyz');
    expect(dd.sourceMultiHaulId).toBe('multi-haul-123');
    expect(dd.sourcePacketId).toBe('pkt-original-456');
    expect(dd.ticketDocIds).toEqual(['ticket-doc-1', 'ticket-doc-2']);
    expect(dd.ticketNumber).toBe(998877);
    expect(dd.invoicingMode).toBe('standard');
  });

  // Scenario 15: Zero partial mutations
  test('15. Transaction failure leaves zero partial mutations across all documents', async () => {
    const invId = 'inv-scen-15';
    const reqId = 'tr-scen-15';

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
    });

    // Attempt create with invalid mode: fails before write
    await expect(
      runCall(
        createDriverTransferRequest,
        { requestId: reqId, sourceInvoiceDocId: invId, toDriverHash: DRIVER_B_ID, mode: 'invalid' as any },
        authDriverA,
      ),
    ).rejects.toThrow();

    // Verify no request doc and no invoice lock
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.exists).toBe(false);
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBeFalsy();
    expect(invSnap.data()!.activeTransferRequestId).toBeUndefined();
  });
});
