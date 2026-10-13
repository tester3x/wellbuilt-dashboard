import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  throw new Error('Firestore and Realtime Database emulators are required');
}
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-live-demo';
if (!projectId.startsWith('demo-')) throw new Error('Refusing a non-demo emulator project');
admin.initializeApp({ projectId, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${projectId}-default-rtdb` });
const { advanceLiveDemoForEmulator } = require('../lib/liveDemo/runtime.js');
const database = admin.database();
const firestore = admin.firestore();
await database.ref('live_demo/viewerAt').set(Date.now());

const start = Date.now();
for (let step = 0; step < 6; step += 1) {
  await advanceLiveDemoForEmulator(start + step * 50_000);
}
const state = (await database.ref('live_demo/state').once('value')).val();
assert.equal(state.sequence, 1);
assert.equal(state.active, null);
assert.equal(state.history[0].id, 'demo-000001');

const company = await firestore.collection('companies').doc('wellbuilt-demo').get();
assert.equal(company.data()?.isDemo, true);
const dispatch = await firestore.collection('dispatches').doc('demo-000001-a-leg-1').get();
assert.equal(dispatch.data()?.status, 'completed');
assert.equal(dispatch.data()?.companyId, 'wellbuilt-demo');
assert.equal(typeof dispatch.data()?.contentHash, 'string');
const invoice = await firestore.collection('invoices').doc('demo-000001-a-invoice').get();
assert.equal(invoice.data()?.totalBBL, 140);
assert.deepEqual(invoice.data()?.tickets, ['900000010']);
const ticket = await firestore.collection('tickets').doc('demo-000001-a-ticket-1').get();
assert.equal(ticket.data()?.ticketNumber, 900000010);

// The demo submits a normal incoming pull to the real pipeline. Trigger
// processing is asynchronous, so poll the processed archive briefly.
let processed = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const snap = await database.ref('packets/processed/demo-000001-a-pull').once('value');
  if (snap.exists()) { processed = true; break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(processed, true, 'processIncomingPull did not archive the demo pull');

// Jump to the next multi-haul sequence and prove that its second pickup is
// still absent when the first physical load closes.
await database.ref('live_demo/state/sequence').set(4);
const multiStart = start + 500_000;
await database.ref('live_demo/viewerAt').set(multiStart);
for (let step = 0; step < 7; step += 1) {
  await advanceLiveDemoForEmulator(multiStart + step * 50_000);
}
const multiState = (await database.ref('live_demo/state').once('value')).val();
assert.equal(multiState.sequence, 5);
assert.equal(multiState.active.loadIndex, 1);
assert.equal(multiState.active.stage, 'pending');
assert.equal((await firestore.collection('dispatches').doc('demo-000005-a-leg-1').get()).data()?.status, 'completed');
assert.equal((await firestore.collection('dispatches').doc('demo-000005-b-leg-1').get()).exists, false);
await advanceLiveDemoForEmulator(multiStart + 7 * 50_000);
assert.equal((await firestore.collection('dispatches').doc('demo-000005-b-leg-1').get()).data()?.status, 'pending');
process.stdout.write('Live demo emulator E2E: single load and sequential multi-haul OK\n');
