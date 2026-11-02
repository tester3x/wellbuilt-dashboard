/* Isolated integration between the two registered functions packages.
 * Usage: node tools/test-dispatch-conversations-emulator.cjs WBT_FUNCTIONS LIVE_RULES_JSON
 * No production credentials, messages, accounts or records are used. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_DATABASE_EMULATOR_HOST, 'Local emulators required');
const admin = require('../functions/node_modules/firebase-admin');
const wbt = path.resolve(process.argv[2]);
const driverAdmin = require(path.join(wbt, 'node_modules/firebase-admin'));
const projectId = 'demo-dispatch-chat';
const options = { projectId, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${projectId}-default-rtdb` };
admin.initializeApp(options); driverAdmin.initializeApp(options);
const db = admin.firestore(), rt = admin.database();
const staffChat = require('../functions/lib/security/staffChat').staffChat.run;
const driverChat = require(path.join(wbt, 'lib/driverChat')).handleDriverChat;
const { deliverLevelReport } = require('../functions/lib/levelReportDelivery');
const { CONVERSATIONS, conversationId } = require('../functions/lib/security/dispatchConversations');
const staff = (uid, data) => staffChat({ auth: { uid, token: {} }, data: { companyId: 'fixture-co', ...data } });
const driver = (id, data) => driverChat(data, { auth: { uid: `auth-${id}`, token: { kind: 'driver', driverId: id, companyId: 'fixture-co' } } });
const doc = id => db.collection(CONVERSATIONS).doc(id);
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS', name); };
async function authority(uid, capabilities, companyId = 'fixture-co') {
  await db.doc(`trusted_staff_authority/${uid}`).set({ schemaVersion: 1, uid, companyId, active: true, capabilities });
}
(async () => {
  for (const uid of ['staff-a', 'staff-b']) await authority(uid, ['viewChat', 'sendChat', 'viewDispatch', 'manageCompany']);
  await authority('chat-only', ['viewChat', 'sendChat']);
  await authority('dispatch-reader', ['viewChat', 'viewDispatch']);
  await authority('foreign', ['viewChat', 'sendChat', 'viewDispatch'], 'other-co');
  await rt.ref('users').update({ 'staff-a': { companyId: 'fixture-co', legalName: 'Fixture Dispatcher A' }, 'staff-b': { companyId: 'fixture-co', legalName: 'Fixture Dispatcher B' } });
  await rt.ref('drivers/profiles').update({ 'driver-a': { companyId: 'fixture-co', active: true, legalName: 'Fixture Driver A' }, 'driver-b': { companyId: 'fixture-co', active: true, legalName: 'Fixture Driver B' } });
  await db.doc('companies/fixture-co').set({ sendLevelToDispatch: true });
  const team = (await staff('staff-a', { action: 'dispatch', driverId: 'driver-a' })).threadId;
  const privateA = (await staff('staff-a', { action: 'private', driverId: 'driver-a' })).threadId;
  const privateB = (await staff('staff-b', { action: 'private', driverId: 'driver-a' })).threadId;
  await check('one team conversation across staff rosters, shifts and concurrent creation', async () => {
    const ids = await Promise.all([staff('staff-b', { action: 'dispatch', driverId: 'driver-a' }), driver('driver-a', { action: 'dispatch' }), staff('staff-a', { action: 'direct', driverId: 'driver-a' })]);
    assert.ok(ids.every(row => row.threadId === team));
    assert.equal(team, conversationId('fixture-co', 'driver-a'));
    assert.notEqual(privateA, privateB);
    assert.equal((await staff('staff-a', { action: 'private', driverId: 'driver-a' })).threadId, privateA);
  });
  await check('both dispatchers see shared messages; private messages stay with exact pair', async () => {
    await staff('staff-a', { action: 'send', threadId: team, clientId: 'shared', text: 'Fixture shared' });
    assert.equal((await staff('staff-b', { action: 'messages', threadId: team })).rows.length, 1);
    await driver('driver-a', { action: 'send', threadId: privateA, clientId: 'private', text: 'Fixture private' });
    assert.equal((await staff('staff-a', { action: 'messages', threadId: privateA })).rows.length, 1);
    for (const action of ['messages', 'send', 'read', 'clear', 'archive', 'broadcast', 'members']) {
      await assert.rejects(() => staff('staff-b', { action, threadId: privateA, text: 'No', clientId: 'no' }));
    }
    assert.equal((await staff('staff-b', { action: 'threads' })).rows.some(row => row.id === privateA), false);
    assert.equal((await staff('staff-b', { action: 'threads', ownOnly: true })).rows.some(row => row.id === team), true);
  });
  await check('current capabilities and company gates apply even with known IDs', async () => {
    for (const uid of ['chat-only', 'foreign']) {
      await assert.rejects(() => staff(uid, { action: 'messages', threadId: team }));
      await assert.rejects(() => staff(uid, { action: 'private', driverId: 'driver-a' }));
    }
    assert.equal((await staff('dispatch-reader', { action: 'messages', threadId: team })).rows.length, 1);
    await assert.rejects(() => staff('dispatch-reader', { action: 'send', threadId: team, text: 'No', clientId: 'no' }));
    for (const action of ['messages', 'send', 'read', 'archive', 'photoUpload', 'thread']) await assert.rejects(() => driver('driver-b', { action, threadId: privateA, text: 'No', clientId: 'no' }));
    await authority('staff-a', ['viewChat', 'sendChat']);
    await assert.rejects(() => staff('staff-a', { action: 'messages', threadId: privateA }));
    await authority('staff-a', ['viewChat', 'sendChat', 'viewDispatch', 'manageCompany']);
  });
  await check('private conversations cannot leak into company monitor profiles or gain members', async () => {
    await assert.rejects(() => staff('staff-a', { action: 'saveProfile', profileId: 'fixture-monitor', record: { slots: [{ threadId: privateA }] } }));
    await staff('staff-a', { action: 'saveProfile', profileId: 'fixture-monitor', record: { slots: [{ threadId: team }] } });
    await assert.rejects(() => staff('staff-a', { action: 'members', threadId: privateA, driverIds: ['driver-a', 'driver-b'] }));
    await assert.rejects(() => staff('staff-a', { action: 'broadcast', threadId: team, broadcast: true }));
    assert.deepEqual((await doc(privateA).get()).get('participants').sort(), ['driver:driver-a', 'user:staff-a']);
  });
  await check('automatic calibrated levels appear once in shared dispatch, never in either private chat', async () => {
    const packet = { driverId: 'driver-a', companyId: 'fixture-co', wellName: 'Fixture Well', tankTopInches: 132, tankAfterInches: 81, bblsTaken: 170, dateTimeUTC: '2026-10-31T00:00:00.000Z' };
    await Promise.all(Array.from({ length: 3 }, () => deliverLevelReport(packet, 'fixture-level')));
    const shared = (await staff('staff-b', { action: 'messages', threadId: team })).rows;
    const levels = shared.filter(row => row.systemType === 'level_report');
    assert.equal(levels.length, 1); assert.match(levels[0].text, /6'9"/);
    assert.equal((await doc(privateA).collection('messages').get()).size, 1);
    assert.equal((await doc(privateB).collection('messages').get()).size, 0);
    const rows = (await driver('driver-a', { action: 'threads' })).threads;
    assert.equal(rows.filter(row => row.id === team).length, 1);
    assert.ok(rows.find(row => row.id === team).participants.length >= 2, 'Installed T286 can display the governed team projection');
    assert.match(rows.find(row => row.id === privateA).title, /Private/);
    assert.ok(!(await driver('driver-b', { action: 'threads' })).threads.some(row => [team, privateA, privateB].includes(row.id)));
  });
  await check('per-person archive and idempotent retries do not hide chats from colleagues', async () => {
    await staff('staff-a', { action: 'archive', threadId: team, archived: true });
    assert.equal((await staff('staff-b', { action: 'threads' })).rows.find(row => row.id === team).status, 'active');
    await Promise.all([1, 2].map(() => staff('staff-a', { action: 'send', threadId: privateA, clientId: 'retry', text: 'Retry fixture' })));
    assert.equal((await doc(privateA).collection('messages').get()).size, 2);
    await assert.rejects(() => staff('staff-a', { action: 'send', threadId: privateA, clientId: 'retry', text: 'Changed fixture' }));
  });
  await check('legacy shift history and saved links converge without losing messages or exposing private chats', async () => {
    const legacy = db.collection('chat_threads').doc('legacy-dispatch-fixture');
    await legacy.set({ companyId: 'fixture-co', type: 'direct', title: 'Driver', status: 'active',
      participants: ['driver:driver-a', 'user:staff-a', 'user:staff-b'], participantNames: {}, lastRead: {} });
    await legacy.collection('messages').doc('shift').set({ text: 'Driver came on shift', senderId: 'system',
      type: 'system', systemType: 'shift_started', timestamp: admin.firestore.Timestamp.fromMillis(1000) });
    await legacy.collection('messages').doc('lost').set({ text: 'Where does this show', senderId: 'driver:driver-a',
      type: 'text', timestamp: admin.firestore.Timestamp.fromMillis(2000) });
    const listed = (await driver('driver-a', { action: 'threads' })).threads;
    assert.ok(!listed.some(row => row.id === legacy.id));
    assert.ok(listed.find(row => row.id === team).legacyThreadIds.includes(legacy.id));
    assert.equal((await legacy.collection('messages').get()).size, 2, 'original history retained');
    assert.ok((await driver('driver-a', { action: 'messages', threadId: team })).messages.some(row => row.text === 'Where does this show'));
    assert.equal((await legacy.get()).get('type'), 'dispatch_history', 'old Suite direct query can no longer select it');
    await driver('driver-a', { action: 'send', threadId: legacy.id, clientId: 'saved-link', text: 'Driver saved link' });
    await staff('staff-b', { action: 'send', threadId: legacy.id, clientId: 'saved-office', text: 'Office saved link' });
    assert.ok((await staff('staff-a', { action: 'messages', threadId: team })).rows.some(row => row.text === 'Driver saved link'));
    assert.ok((await driver('driver-a', { action: 'messages', threadId: team })).messages.some(row => row.text === 'Office saved link'));
    assert.ok(!(await staff('staff-b', { action: 'threads' })).rows.some(row => row.id === legacy.id));
    await assert.rejects(() => driver('driver-b', { action: 'messages', threadId: legacy.id }));
    await assert.rejects(() => staff('chat-only', { action: 'messages', threadId: legacy.id }));
    await driver('driver-a', { action: 'threads' });
    assert.equal((await doc(team).collection('messages').where('legacySource.threadId', '==', legacy.id).get()).size, 2, 'repeat migration is idempotent');
  });
  await check('unread badge counts incoming messages and retains them after own automatic reports', async () => {
    await driver('driver-a', { action: 'read', threadId: team });
    await staff('staff-a', { action: 'send', threadId: team, clientId: 'count-one', text: 'First unread' });
    await staff('staff-b', { action: 'send', threadId: team, clientId: 'count-two', text: 'Latest received' });
    await driver('driver-a', { action: 'send', threadId: team, clientId: 'own-outgoing', text: 'Outgoing report fixture' });
    let thread = (await driver('driver-a', { action: 'threads' })).threads.find(row => row.id === team);
    assert.equal(thread.unreadCount, 2, 'two senders/messages, one conversation');
    assert.equal(thread.lastUnreadMessage.text, 'Latest received');
    await staff('staff-b', { action: 'send', threadId: team, clientId: 'count-three', text: 'Third unread from same person' });
    thread = (await driver('driver-a', { action: 'threads' })).threads.find(row => row.id === team);
    assert.equal(thread.unreadCount, 3, 'counts messages rather than senders');
    await driver('driver-a', { action: 'read', threadId: team });
    assert.equal((await driver('driver-a', { action: 'threads' })).threads.find(row => row.id === team).unreadCount, 0);
    await staff('staff-a', { action: 'read', threadId: team });
    await staff('staff-a', { action: 'send', threadId: team, clientId: 'office-own', text: 'Own office send' });
    assert.equal((await staff('staff-a', { action: 'threads' })).rows.find(row => row.id === team).unreadCount, 0);
  });
  await check('large dispatch histories migrate in bounded batches without truncation', async () => {
    const legacy = db.collection('chat_threads').doc('large-legacy-dispatch-fixture');
    await legacy.set({ companyId: 'fixture-co', type: 'direct', title: 'Driver', status: 'active',
      participants: ['driver:driver-b', 'user:staff-a'], participantNames: {}, lastRead: {} });
    const batch = db.batch();
    for (let i = 0; i < 405; i++) batch.set(legacy.collection('messages').doc(`m-${i}`), {
      text: `History ${i}`, senderId: i === 0 ? 'system' : 'driver:driver-b', type: i === 0 ? 'system' : 'text',
      ...(i === 0 ? { systemType: 'shift_started' } : {}), timestamp: admin.firestore.Timestamp.fromMillis(i + 1000),
    });
    await batch.commit();
    const rows = (await driver('driver-b', { action: 'threads' })).threads;
    const target = rows.find(row => row.audience === 'dispatch_team');
    assert.ok(!rows.some(row => row.id === legacy.id));
    assert.equal((await doc(target.id).collection('messages').where('legacySource.threadId', '==', legacy.id).get()).size, 405);
    assert.equal((await legacy.collection('messages').get()).size, 405);
  });
  await check('shift start/end use the same shared conversation, stable retries and chronological previews', async () => {
    const { postShiftDispatchNotice } = require('../functions/lib/security/shiftDispatchChat');
    const shift = { driverId: 'driver-a', companyId: 'fixture-co', loginAt: '2026-01-01T10:00:00Z' };
    assert.equal(await postShiftDispatchNotice(shift, 'first-shift-fixture', 'shift_started', null), team);
    await postShiftDispatchNotice(shift, 'first-shift-fixture', 'shift_started', null);
    assert.equal((await doc(team).collection('messages').where('systemData.shiftId', '==', 'first-shift-fixture').get()).size, 1);
    await postShiftDispatchNotice({ ...shift, logoutAt: '2026-01-01T11:00:00Z' }, 'first-shift-fixture', 'shift_ended', null);
    assert.equal((await doc(team).get()).get('lastMessage.text'), 'Own office send', 'late historical shift event cannot overwrite a new preview');
    assert.equal((await doc(team).get()).get('status'), 'active', 'ending a shift never archives the persistent conversation');
    assert.equal(await postShiftDispatchNotice({ ...shift, companyId: 'other-co' }, 'foreign-shift', 'shift_started', null), null);
  });
  await check('permanent announcements reach off-shift drivers with individual durable receipts and trusted authors', async () => {
    const { ANNOUNCEMENTS, announcementId } = require('../functions/lib/security/dispatchAnnouncements');
    const id = announcementId('fixture-co');
    await rt.ref('drivers/profiles/driver-off').set({ companyId: 'fixture-co', active: true, legalName: 'Fixture Off Shift' });
    await Promise.all([1, 2, 3].map(() => staff('staff-a', { action: 'send', threadId: id, clientId: 'announcement-retry', text: 'Synthetic dispatch announcement', senderName: 'Fake Login' })));
    await staff('staff-b', { action: 'send', threadId: id, clientId: 'announcement-two', text: 'Synthetic second announcement' });
    const room = db.collection(ANNOUNCEMENTS).doc(id);
    assert.equal((await room.collection('messages').get()).size, 2);
    const notice = await room.collection('messages').doc('c_announcement-retry').get();
    assert.equal(notice.get('senderName'), 'Fixture Dispatcher A');
    assert.ok(notice.get('recipientIds').includes('driver-off'));
    assert.equal((await driver('driver-off', { action: 'threads' })).threads[0].unreadCount, 2);
    await driver('driver-off', { action: 'read', threadId: id });
    assert.equal((await driver('driver-off', { action: 'threads' })).threads[0].unreadCount, 2);
    for (const action of ['send', 'photoUpload', 'archive']) await assert.rejects(() => driver('driver-off', { action, threadId: id, clientId: 'denied', text: 'No' }));
    for (const uid of ['chat-only', 'foreign']) await assert.rejects(() => staff(uid, { action: 'messages', threadId: id }));
    await assert.rejects(() => staff('dispatch-reader', { action: 'send', threadId: id, clientId: 'denied', text: 'No' }));
    await Promise.all([1,2,3].map(() => driver('driver-off', { action: 'acknowledge', threadId: id, messageId: notice.id, driverId: 'driver-a' })));
    assert.equal((await room.collection('receipts').get()).size, 1);
    assert.equal((await driver('driver-off', { action: 'threads' })).threads[0].unreadCount, 1);
    assert.equal((await driver('driver-a', { action: 'threads' })).threads[0].unreadCount, 2);
    const messages = (await staff('staff-b', { action: 'messages', threadId: id })).rows;
    const receipts = messages.find(row => row.id === notice.id).receiptSummary;
    assert.equal(receipts.find(row => row.driverId === 'driver-off').name, 'Fixture Off Shift');
    assert.ok(receipts.find(row => row.driverId === 'driver-off').acknowledgedAt);
    assert.equal(receipts.find(row => row.driverId === 'driver-a').acknowledgedAt, null);
    assert.equal((await driver('driver-off', { action: 'messages', threadId: id })).messages[0].receiptSummary, undefined);
    await staff('staff-a', { action: 'saveProfile', profileId: 'announcement-monitor', record: { slots: [{ threadId: id }] } });
    for (const action of ['archive','clear','members','broadcast']) await assert.rejects(() => staff('staff-a', { action, threadId: id }));
  });
  if (process.argv[3]) await check('deployed-equivalent rules deny direct reads including company staff and platform admin', async () => {
    const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
    const { getDoc, setDoc, doc: clientDoc, collection, getDocs } = require('firebase/firestore');
    const live = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const files = live.source?.files || live.files?.source?.files || live.files?.files || live.files;
    const rules = Array.isArray(files) ? files.find(file => file.name.endsWith('.rules')).content : null;
    assert.equal(typeof rules, 'string', 'Exact fetched live rules are required');
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    const env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules } });
    await db.doc('staff/staff-b').set({ companyId: 'fixture-co', enabled: true, role: 'dispatch' });
    await db.doc('platform_admins/platform').set({ enabled: true });
    for (const [uid, claims] of [['staff-b', {}], ['platform', { wellbuiltAdmin: true }], ['driver-auth', { kind: 'driver', driverId: 'driver-a', companyId: 'fixture-co' }]]) {
      const client = env.authenticatedContext(uid, claims).firestore();
      for (const id of [team, privateA]) {
        await assertFails(getDoc(clientDoc(client, CONVERSATIONS, id)));
        await assertFails(getDocs(collection(client, CONVERSATIONS, id, 'messages')));
      }
    }
    const { ANNOUNCEMENTS, announcementId } = require('../functions/lib/security/dispatchAnnouncements');
    const aid = announcementId('fixture-co');
    for (const claims of [{}, { kind: 'driver', driverId: 'driver-off', companyId: 'fixture-co' }, { wellbuiltAdmin: true }]) {
      const client = env.authenticatedContext('announcement-client', claims).firestore();
      for (const tail of ['', '/messages/c_announcement-retry', '/receipts/c_announcement-retry_driver-off']) {
        await assertFails(getDoc(clientDoc(client, ANNOUNCEMENTS + '/' + aid + tail)));
        await assertFails(setDoc(clientDoc(client, ANNOUNCEMENTS + '/' + aid + tail), { spoofed: true }));
      }
      await assertFails(getDocs(collection(client, ANNOUNCEMENTS, aid, 'messages')));
    }
    await env.cleanup();
  });
  console.log(`Dispatch conversations: ${checks} integration checks passed.`);
  await admin.app().delete(); await driverAdmin.app().delete();
})().catch(async error => { console.error(error); await Promise.allSettled([admin.app().delete(), driverAdmin.app().delete()]); process.exitCode = 1; });
