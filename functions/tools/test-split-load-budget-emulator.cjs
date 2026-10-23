// Runs the real compiled callable and Firestore transactions in a demo emulator.
const assert = require('node:assert/strict');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.GCLOUD_PROJECT?.startsWith('demo-')) {
  throw Error('A demo Firestore emulator is required; refusing live access');
}
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
require('../lib/security/requireDriverAuth').requireSecureDriver = async () => ({
  uid: 'test-auth', driverId: 'test-driver', companyId: 'test-company', authSource: 'test',
});
require('../lib/security/audit').writeSecurityAudit = async () => {};
const { upsertDriverInvoice } = require('../lib/security/operational/invoiceOps');
const companyId = 'test-company', driverId = 'test-driver', group = 'test-family';
const close = (id, amount, extra = {}) => upsertDriverInvoice.run({ data: {
  invoiceId: `inv-${id}`, invoice: { dispatchId: id, status: 'closed', totalBBL: amount, ...extra },
} });
(async () => {
  for (const [id, seq] of [['A', 1], ['B', 2], ['C', 3]]) {
    await db.collection('dispatches').doc(id).set({ companyId, driverId, splitGroupId: group, splitSequence: seq });
  }
  await close('A', 70);
  // Different invoice IDs still contend on the same ledger. One must retry
  // against the other's confirmed use and reject the 80/70 overdraw.
  const results = await Promise.allSettled([close('B', 40), close('C', 40)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const winner = results[0].status === 'fulfilled' ? 'B' : 'C';
  const loser = winner === 'B' ? 'C' : 'B';
  assert.equal((await db.doc(`invoices/inv-${loser}`).get()).exists, false, 'rejected close writes nothing');
  await close(winner, 40);
  assert.equal((await db.doc(`split_load_ledgers/${group}`).get()).data().usedBbls, 40, 'retry does not double count');
  await close(loser, 30, { dispatchSplitGroupId: 'forged-family', dispatchSplitSequence: 1 });
  const ledger = (await db.doc(`split_load_ledgers/${group}`).get()).data();
  assert.equal(ledger.pickupBbls, 70); assert.equal(ledger.usedBbls, 70); assert.equal(ledger.remainingBbls, 0);
  assert.equal((await db.doc(`invoices/inv-${loser}`).get()).data().dispatchSplitGroupId, group, 'server derives family');
  await assert.rejects(close(loser, 31), /split_pickup_exceeded/);
  assert.equal((await db.doc(`invoices/inv-${loser}`).get()).data().totalBBL, 30, 'failed edit preserves confirmed amount');
  await db.doc('dispatches/foreign').set({ companyId: 'other-company', driverId, splitGroupId: 'foreign-group', splitSequence: 1 });
  await assert.rejects(close('foreign', 70), /another driver or company/);
  await db.doc('dispatches/regular').set({ companyId, driverId });
  await close('regular', 100);
  assert.equal((await db.doc('invoices/inv-regular').get()).data().totalBBL, 100, 'ordinary close remains supported');
  console.log('PASS: real callable + emulator transactions: simultaneous overdraw, retry, exact exhaustion, forged family, rejected edits, company scope and ordinary close');
  await db.terminate(); await admin.app().delete();
})().catch(error => { console.error(error); process.exitCode = 1; });
