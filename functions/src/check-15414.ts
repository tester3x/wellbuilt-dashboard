import * as admin from 'firebase-admin';
import * as path from 'path';

const serviceAccount = require(path.resolve(__dirname, '..', '..', 'serviceAccountKey.json'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com'
});

const db = admin.firestore();

async function main() {
  // 1. Latest closed invoices - query by createdAt desc, filter status client-side
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 1: LATEST 5 CLOSED INVOICES');
  console.log('='.repeat(80));
  const recentSnap = await db.collection('invoices')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  let closedCount = 0;
  recentSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.status !== 'closed') return;
    if (closedCount >= 5) return;
    closedCount++;
    console.log(`\n--- Closed Invoice #${closedCount} ---`);
    console.log(`  docId:              ${doc.id}`);
    console.log(`  invoiceNumber:      ${d.invoiceNumber}`);
    console.log(`  tickets:            ${JSON.stringify(d.tickets)}`);
    console.log(`  driver:             ${d.driver}`);
    console.log(`  totalHours:         ${d.totalHours}`);
    console.log(`  totalBBL:           ${d.totalBBL}`);
    console.log(`  wellName:           ${d.wellName}`);
    console.log(`  hauledTo:           ${d.hauledTo}`);
    console.log(`  county:             ${d.county}`);
    console.log(`  swdWaitMinutes:     ${d.swdWaitMinutes}`);
    console.log(`  driveDistanceMiles: ${d.driveDistanceMiles}`);
    console.log(`  invoiceStartedAt:   ${d.invoiceStartedAt}`);
    console.log(`  closedAt:           ${d.closedAt}`);
    console.log(`  status:             ${d.status}`);
    console.log(`  date:               ${d.date}`);
    console.log(`  invoicingMode:      ${d.invoicingMode}`);
  });
  if (closedCount === 0) console.log('No closed invoices found in the latest 20.');

  // 2. Open invoices for 03/30/2026
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 2: OPEN INVOICES FOR 03/30/2026');
  console.log('='.repeat(80));
  const openSnap = await db.collection('invoices')
    .where('date', '==', '03/30/2026')
    .get();

  let openCount = 0;
  openSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.status !== 'open') return;
    openCount++;
    console.log(`\n--- Open Invoice #${openCount} (docId: ${doc.id}) ---`);
    console.log(JSON.stringify(d, null, 2));
  });
  if (openCount === 0) console.log('No open invoices found for 03/30/2026.');

  // Also show ALL invoices for that date regardless of status
  console.log(`\n  (Total invoices for 03/30/2026: ${openSnap.size})`);
  openSnap.docs.forEach(doc => {
    const d = doc.data();
    console.log(`    ${doc.id} => status=${d.status}, invoiceNumber=${d.invoiceNumber}, wellName=${d.wellName}`);
  });

  // 3. Ticket #15414 (string and number)
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 3: TICKET #15414');
  console.log('='.repeat(80));

  const t14strSnap = await db.collection('tickets')
    .where('ticketNumber', '==', '15414')
    .get();
  const t14numSnap = await db.collection('tickets')
    .where('ticketNumber', '==', 15414)
    .get();

  const seen = new Set<string>();
  const allT14 = [...t14strSnap.docs, ...t14numSnap.docs];
  if (allT14.length === 0) {
    console.log('No tickets found with ticketNumber 15414 (tried string and number).');
  }
  allT14.forEach(doc => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    console.log(`\n--- Ticket doc: ${doc.id} ---`);
    console.log(JSON.stringify(doc.data(), null, 2));
  });

  // 4. Ticket #15413 for comparison
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 4: TICKET #15413 (comparison)');
  console.log('='.repeat(80));

  const t13strSnap = await db.collection('tickets')
    .where('ticketNumber', '==', '15413')
    .get();
  const t13numSnap = await db.collection('tickets')
    .where('ticketNumber', '==', 15413)
    .get();

  const seen2 = new Set<string>();
  const allT13 = [...t13strSnap.docs, ...t13numSnap.docs];
  if (allT13.length === 0) {
    console.log('No tickets found with ticketNumber 15413 (tried string and number).');
  }
  allT13.forEach(doc => {
    if (seen2.has(doc.id)) return;
    seen2.add(doc.id);
    console.log(`\n--- Ticket doc: ${doc.id} ---`);
    console.log(JSON.stringify(doc.data(), null, 2));
  });

  // 5. Latest 2 completed dispatches
  console.log('\n' + '='.repeat(80));
  console.log('SECTION 5: LATEST 2 COMPLETED DISPATCHES');
  console.log('='.repeat(80));
  // Query by completedAt desc, filter completed client-side
  const dispSnap = await db.collection('dispatches')
    .orderBy('completedAt', 'desc')
    .limit(10)
    .get();

  let compCount = 0;
  dispSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.status !== 'completed') return;
    if (compCount >= 2) return;
    compCount++;
    console.log(`\n--- Completed Dispatch #${compCount} ---`);
    console.log(`  id:              ${doc.id}`);
    console.log(`  status:          ${d.status}`);
    console.log(`  ticketNumber:    ${d.ticketNumber}`);
    console.log(`  invoiceNumber:   ${d.invoiceNumber}`);
    console.log(`  invoiceDocId:    ${d.invoiceDocId}`);
    console.log(`  driver:          ${d.driver}`);
    console.log(`  driverName:      ${d.driverName}`);
    console.log(`  wellName:        ${d.wellName}`);
    console.log(`  totalBBL:        ${d.totalBBL}`);
    console.log(`  completedAt:     ${d.completedAt}`);
    console.log(`  invoicingMode:   ${d.invoicingMode}`);
  });
  if (compCount === 0) console.log('No completed dispatches found in the latest 10.');

  console.log('\n' + '='.repeat(80));
  console.log('DONE');
  console.log('='.repeat(80));

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
