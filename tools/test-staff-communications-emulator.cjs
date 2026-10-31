const assert = require('node:assert/strict');
const admin = require('../functions/node_modules/firebase-admin');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_DATABASE_EMULATOR_HOST, 'Emulators required');
const projectId = 'demo-communications';
admin.initializeApp({ projectId, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${projectId}-default-rtdb` });
const db = admin.firestore(), rt = admin.database();
const chat = require('../functions/lib/security/staffChat').staffChat.run;
const transfer = require('../functions/lib/security/staffLoadTransfers').staffLoadTransfers.run;
const { upsertDriverInvoice, sendChatMessage } = require('../functions/lib/security/operational/invoiceOps');
const { runTransferRequestExpiry, runTransferRequestExpiryOnDemand } = require('../functions/lib/transfer-request-expiry');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const staff = { uid: 'fixture-dispatch', token: {} }, viewer = { uid: 'fixture-viewer', token: {} };
const request = (data, auth = staff) => ({ data, auth });
const call = data => chat(request({ companyId: 'fixture-co', ...data }));
let count = 0;
async function check(label, run) { await run(); console.log('PASS', label); count++; }
(async () => {
  for (const [auth, capabilities] of [[staff, ['viewChat','sendChat','viewDispatch','createDispatch','manageCompany']], [viewer, ['viewChat','viewDispatch']]]) {
    await db.doc(`trusted_staff_authority/${auth.uid}`).set({ schemaVersion: 1, uid: auth.uid, companyId: 'fixture-co', active: true, capabilities });
  }
  await rt.ref('drivers/profiles').update({ [A]: { active: true, companyId: 'fixture-co', legalName: 'Fixture A' }, [B]: { active: true, companyId: 'fixture-co', legalName: 'Fixture B' } });
  await check('unproven and cross-company staff denied', async () => {
    await assert.rejects(() => chat(request({ action: 'threads' }, { uid: 'unproven', token: { wellbuiltAdmin: true } })));
    await assert.rejects(() => call({ action: 'threads', companyId: 'foreign' }));
    await assert.rejects(() => chat(request({ action: 'direct', driverId: A }, viewer)));
  });
  const { threadId } = await call({ action: 'direct', driverId: A });
  await check('direct identity reused and member canonical', async () => {
    assert.equal((await call({ action: 'direct', driverId: A })).threadId, threadId);
    assert.deepEqual((await db.doc(`dispatch_conversations/${threadId}`).get()).get('participantIds'), [A]);
  });
  await check('staff retry creates one message with server sender', async () => {
    await Promise.all([call({ action: 'send', threadId, clientId: 'once', text: 'Fixture text', senderId: 'spoof' }), call({ action: 'send', threadId, clientId: 'once', text: 'Fixture text' })]);
    const rows = (await call({ action: 'messages', threadId })).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].senderId, 'user:fixture-dispatch'); assert.ok(rows[0].timestamp);
    await assert.rejects(() => call({ action: 'send', threadId, clientId: 'once', text: 'Overwrite' }));
  });
  await check('viewer cannot send or change monitor profiles', async () => {
    await assert.rejects(() => chat(request({ action: 'send', threadId, clientId: 'viewer', text: 'No' }, viewer)));
    await assert.rejects(() => chat(request({ action: 'saveProfile', profileId: 'viewer', record: { name: 'No' } }, viewer)));
  });
  await check('monitor profiles are scoped and preserve configured slots', async () => {
    await call({ action: 'saveProfile', profileId: 'monitor', record: { name: 'Fixture', gridLayout: '2x2', slots: [{ threadId }, null] } });
    const rows = (await call({ action: 'profiles' })).rows; assert.equal(rows.length, 1); assert.equal(rows[0].slots[0].threadId, threadId);
    await db.doc('chat_threads/foreign').set({ companyId: 'foreign' });
    await assert.rejects(() => call({ action: 'saveProfile', profileId: 'monitor', record: { slots: [{ threadId: 'foreign' }] } }));
  });
  await check('group members canonical and outside company denied', async () => {
    const group = await call({ action: 'group', requestId: 'fixture-group', type: 'service_group', title: 'Fixture crew', driverIds: [A] });
    await call({ action: 'members', threadId: group.threadId, driverIds: [A, B] });
    assert.deepEqual((await db.doc('chat_threads/fixture-group').get()).get('participantIds'), [A, B]);
    await assert.rejects(() => call({ action: 'members', threadId: group.threadId, driverIds: ['foreign-driver'] }));
  });
  await db.doc('invoices/approval').set({ companyId: 'fixture-co', driverId: A, status: 'open', lockedForTransfer: true, activeTransferRequestId: 'approval' });
  await db.doc('transfer_requests/approval').set({ companyId: 'fixture-co', fromDriverId: A, sourceInvoiceDocId: 'approval', mode: 'approval', status: 'pending' });
  await check('dispatch assignment offers but does not transfer ownership', async () => {
    await assert.rejects(() => transfer(request({ action: 'assign', requestId: 'approval', driverId: B }, viewer)));
    await transfer(request({ action: 'assign', requestId: 'approval', driverId: B }));
    assert.equal((await db.doc('invoices/approval').get()).get('driverId'), A);
    assert.equal((await db.doc('transfer_requests/approval').get()).get('toDriverId'), B);
    await transfer(request({ action: 'assign', requestId: 'approval', driverId: B }));
  });
  await check('locked invoice cannot be edited or unlocked through regular save', async () => {
    const auth = { uid: 'fixture-driver', token: { kind: 'driver', driverId: A, companyId: 'fixture-co' } };
    await assert.rejects(() => upsertDriverInvoice.run(request({ invoiceId: 'approval', invoice: { status: 'closed', lockedForTransfer: false } }, auth)));
    assert.equal((await db.doc('invoices/approval').get()).get('lockedForTransfer'), true);
  });
  await check('legacy chat endpoint cannot bypass membership or broadcast policy', async () => {
    const auth = { uid: 'fixture-driver', token: { kind: 'driver', driverId: B, companyId: 'fixture-co' } };
    await assert.rejects(() => sendChatMessage.run(request({ threadId, text: 'No', clientId: 'attack', driverHash: A }, auth)));
    await assert.rejects(() => sendChatMessage.run(request({ threadId, text: 'No', clientId: 'attack', driverHash: A }, undefined)));
  });
  await check('expiry unlocks only its own offer and keeps the sender job open', async () => {
    for (const id of ['expired', 'replaced']) {
      await db.doc(`transfer_requests/${id}`).set({ companyId: 'fixture-co', status: 'pending', sourceInvoiceDocId: id, ttlExpiresAt: admin.firestore.Timestamp.fromMillis(1) });
      await db.doc(`invoices/${id}`).set({ companyId: 'fixture-co', driverId: A, status: 'open', lockedForTransfer: true, activeTransferRequestId: id === 'replaced' ? 'newer-offer' : id });
    }
    const result = await runTransferRequestExpiry(100, 'fixture-co'); assert.equal(result.errors.length, 0); assert.equal(result.expired.length, 2);
    assert.equal((await db.doc('invoices/expired').get()).get('lockedForTransfer'), false);
    assert.equal((await db.doc('invoices/expired').get()).get('status'), 'open');
    assert.equal((await db.doc('invoices/replaced').get()).get('activeTransferRequestId'), 'newer-offer');
    await assert.rejects(() => runTransferRequestExpiryOnDemand.run({}, { auth: { uid: 'unproven', token: {} } }));
  });
  console.log(`Staff communications: ${count} checks passed.`);
  await admin.app().delete();
})().catch(async error => { console.error(error); await admin.app().delete(); process.exitCode = 1; });
