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
  if (process.argv[3]) await check('deployed-equivalent rules deny direct reads including company staff and platform admin', async () => {
    const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
    const { getDoc, doc: clientDoc, collection, getDocs } = require('firebase/firestore');
    const live = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const files = live.files?.source?.files || live.files?.files || live.files;
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
    await env.cleanup();
  });
  console.log(`Dispatch conversations: ${checks} integration checks passed.`);
  await admin.app().delete(); await driverAdmin.app().delete();
})().catch(async error => { console.error(error); await Promise.allSettled([admin.app().delete(), driverAdmin.app().delete()]); process.exitCode = 1; });
