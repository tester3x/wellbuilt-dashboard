const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_DATABASE_EMULATOR_HOST, 'Emulators required');
const admin = require('../functions/node_modules/firebase-admin');
const projectId = 'demo-level-chat';
admin.initializeApp({ projectId, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${projectId}-default-rtdb` });
const { deliverLevelReport, productionLevelChatDeps, levelReportMessageId } = require('../functions/lib/levelReportDelivery');
const { CONVERSATIONS, conversationId } = require('../functions/lib/security/dispatchConversations');
const db = admin.firestore(), rt = admin.database();
const team = conversationId('fixture-co', 'fixture-driver');
const packet = { driverId: 'fixture-driver', companyId: 'fixture-co', wellName: 'Fixture Well',
  tankTopInches: 132, tankAfterInches: 81, bblsTaken: 170, dateTimeUTC: '2026-10-30T21:59:00.000Z', timezone: 'America/Chicago' };
(async () => {
  await rt.ref('drivers/profiles/fixture-driver').set({ companyId: 'fixture-co', legalName: 'Fixture Employee', displayName: 'LoginOnly' });
  await rt.ref('drivers/identityBindings/byDriver/fixture-driver').set({ driverId: 'fixture-driver', approvedKey: 'legacy-fixture', opId: 'fixture-proof' });
  await rt.ref('drivers/identityBindings/byApproved/legacy-fixture').set({ driverId: 'fixture-driver', approvedKey: 'legacy-fixture', opId: 'fixture-proof' });
  await db.doc('companies/fixture-co').set({ sendLevelToDispatch: true, levelReportTemplate: '{driverName}: {well} {top} -> {bottom}, {bbls} BBL' });
  for (const [thread, companyId, driverId] of [
    ['first', 'fixture-co', 'fixture-driver'], ['second', 'fixture-co', 'legacy-fixture'],
    ['foreign', 'other-co', 'fixture-driver'], ['unrelated', 'fixture-co', 'different-driver'],
  ]) await db.doc(`chat_threads/${thread}`).set({ type: 'direct', companyId, participants: [`driver:${driverId}`, 'user:fixture-dispatch'] });
  await Promise.all(Array.from({ length: 4 }, () => deliverLevelReport(packet, 'fixture-packet')));
  const messageId = levelReportMessageId('fixture-packet', 'fixture-co', 'fixture-driver');
  for (const thread of [team]) {
    const messages = await db.collection(`${CONVERSATIONS}/${thread}/messages`).get();
    assert.equal(messages.size, 1, 'Concurrent retries create one report per eligible thread');
    assert.equal(messages.docs[0].id, messageId);
    assert.match(messages.docs[0].get('text'), /11'0" -> 6'9"/);
    assert.equal(messages.docs[0].get('senderName'), 'Fixture Employee');
    assert.equal(messages.docs[0].get('sourcePacketId'), 'fixture-packet');
    assert.ok(messages.docs[0].get('timestamp').toMillis());
  }
  for (const thread of ['first', 'second', 'foreign', 'unrelated']) assert.equal((await db.collection(`chat_threads/${thread}/messages`).get()).size, 0);
  const newer = { text: 'Newer fixture message', senderId: 'user:fixture-dispatch', timestamp: admin.firestore.Timestamp.now() };
  await db.doc(`${CONVERSATIONS}/${team}`).update({ lastMessage: newer });
  await deliverLevelReport(packet, 'idem_fixture-packet');
  assert.equal((await db.doc(`${CONVERSATIONS}/${team}`).get()).get('lastMessage.text'), newer.text, 'Replay cannot replace newer preview');
  await db.doc(`${CONVERSATIONS}/${team}`).update({ companyId: 'other-co' });
  await assert.rejects(() => productionLevelChatDeps().writeOnce(team, 'blocked', 'fixture-co', ['fixture-driver'], { sourcePacketId: 'blocked' }));
  assert.equal((await db.doc(`${CONVERSATIONS}/${team}/messages/blocked`).get()).exists, false, 'Transaction rechecks company/membership');
  await db.doc('companies/fixture-co').update({ sendLevelToDispatch: false });
  assert.equal((await deliverLevelReport(packet, 'disabled')).result, 'disabled');
  assert.equal((await db.collection(`${CONVERSATIONS}/${team}/messages`).get()).size, 1);
  console.log('PASS level-chat emulator: concurrent dedup, canonical identity delivery to dispatch team, calibrated bottom, timestamp, tenant exclusion, transactional recheck, newer preview preservation and disabled setting.');
  await admin.app().delete();
})().catch(async error => { console.error(error); await admin.app().delete(); process.exitCode = 1; });
