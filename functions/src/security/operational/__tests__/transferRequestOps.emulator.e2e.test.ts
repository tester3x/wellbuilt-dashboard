/**
 * Real Firestore + RTDB emulator test suite for governed transfer request lifecycle.
 * Exercises createDriverTransferRequest, resolveTransferRequest, and acceptTransferRequest
 * against real emulator boundaries across all 15+ required safety scenarios.
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

  // Scenario 2: Canonical dispatch creation
  test('2. Canonical dispatch creation when accepting transfer without existing dispatch', async () => {
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
    expect(acceptRes.targetDispatchId).toBeDefined();

    // Verify newly created dispatch in Firestore
    const newDispSnap = await db.collection('dispatches').doc(acceptRes.targetDispatchId).get();
    expect(newDispSnap.exists).toBe(true);
    const d = newDispSnap.data()!;
    expect(d.driverId).toBe(DRIVER_B_ID);
    expect(d.driverHash).toBe(DRIVER_B_ID);
    expect(d.driverName).toBe('Driver B Receiver');
    expect(d.companyId).toBe(COMPANY);
    expect(d.status).toBe('assigned');
    expect(d.wellName).toBe('BULLDOG 12-1H');
    expect(d.operator).toBe('Devon Energy');
    expect(d.canonicalJobId).toBe('job-can-99');
    expect(d.sourceMultiHaulId).toBe('haul-group-88');
    expect(d.sourcePacketId).toBe('pkt-source-77');
    expect(d.ticketDocIds).toEqual(['tkt-1', 'tkt-2']);
    expect(d.ticketNumber).toBe('TK-445566');
    expect(d.invoicingMode).toBe('split_haul');
    expect(d.transferredFromHash).toBe(DRIVER_A_ID);
    expect(d.sourceInvoiceDocId).toBe(invId);
    expect(d.transferRequestId).toBe(reqId);
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

  // Scenario 4: Wrong driver accept/decline
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

    // Driver C tries to decline
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'decline' }, authDriverC),
    ).rejects.toThrow(/Only requested recipient can decline this transfer/);

    // Driver B (recipient) tries to cancel
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'cancel' }, authDriverB),
    ).rejects.toThrow(/Only sender can cancel this transfer request/);

    // Request is still pending and invoice is still locked
    const reqSnap = await db.collection('transfer_requests').doc(reqId).get();
    expect(reqSnap.data()!.status).toBe('pending');
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(true);
  });

  // Scenario 5: Approval-mode unauthorized accept/decline
  test('5. Approval-mode rejects unauthorized accept or decline by non-privileged drivers', async () => {
    const invId = 'inv-scen-5';
    const reqId = 'tr-scen-5';
    const dispId = 'disp-scen-5';

    await db.collection('dispatches').doc(dispId).set({
      id: dispId,
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'pending_approval',
    });

    await db.collection('invoices').doc(invId).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      dispatchId: dispId,
    });

    // Create approval-mode transfer request without specific recipient
    await runCall(
      createDriverTransferRequest,
      { requestId: reqId, sourceInvoiceDocId: invId, mode: 'approval' },
      authDriverA,
    );

    // Unassigned Driver C tries to decline
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'decline' }, authDriverC),
    ).rejects.toThrow(/Unauthorized to decline approval-mode transfer request/);

    // Unassigned Driver C tries to accept
    await expect(
      runCall(acceptTransferRequest, { requestId: reqId }, authDriverC),
    ).rejects.toThrow(/Unauthorized to accept approval-mode transfer request/);

    // Privileged dispatcher CAN decline
    const declineRes = await runCall(
      resolveTransferRequest,
      { requestId: reqId, action: 'decline', reason: 'Rejected by dispatch' },
      authDispatcher,
    );
    expect(declineRes.ok).toBe(true);
    expect(declineRes.status).toBe('declined');
  });

  // Scenario 6: Unauthorized and premature expiry
  test('6. Premature expiry by driver rejected; privileged staff or elapsed TTL succeeds', async () => {
    const invId = 'inv-scen-6';
    const reqId = 'tr-scen-6';

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

    // Driver A attempts premature expiry (TTL is 4 hours in the future)
    await expect(
      runCall(resolveTransferRequest, { requestId: reqId, action: 'expire' }, authDriverA),
    ).rejects.toThrow(/Unauthorized or premature transfer request expiration/);

    // Dispatcher staff CAN expire at any time
    const staffExpire = await runCall(
      resolveTransferRequest,
      { requestId: reqId, action: 'expire', reason: 'Expired by staff' },
      authDispatcher,
    );
    expect(staffExpire.ok).toBe(true);
    expect(staffExpire.status).toBe('expired');

    // Verify invoice unlocked
    const invSnap = await db.collection('invoices').doc(invId).get();
    expect(invSnap.data()!.lockedForTransfer).toBe(false);

    // Now test elapsed TTL branch:
    const invId2 = 'inv-scen-6-elapsed';
    const reqId2 = 'tr-scen-6-elapsed';
    await db.collection('invoices').doc(invId2).set({
      driverId: DRIVER_A_ID,
      companyId: COMPANY,
      status: 'open',
      activeTransferRequestId: reqId2,
      lockedForTransfer: true,
    });
    // Write request doc with past ttlExpiresAt
    await db.collection('transfer_requests').doc(reqId2).set({
      id: reqId2,
      sourceInvoiceDocId: invId2,
      fromDriverHash: DRIVER_A_ID,
      toDriverHash: DRIVER_B_ID,
      mode: 'direct',
      status: 'pending',
      companyId: COMPANY,
      ttlExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 10000), // in the past
    });

    // Driver A can now expire because TTL has passed
    const driverExpire = await runCall(
      resolveTransferRequest,
      { requestId: reqId2, action: 'expire' },
      authDriverA,
    );
    expect(driverExpire.ok).toBe(true);
    expect(driverExpire.status).toBe('expired');
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
  test('10. Invoice locked by different request ID cannot be accepted or re-requested', async () => {
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
