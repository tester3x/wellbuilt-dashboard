/**
 * One-off script: Patch s_t invoice docs that have driver='' and totalHours=0.
 * Recalculates hours from invoiceStartedAt + closedAt.
 * Resolves driver name from dispatchId → dispatch doc → driverName.
 *
 * Run: npx ts-node --project tsconfig.json src/fix-st-invoices.ts
 */

import * as admin from 'firebase-admin';

const serviceAccount = require('../../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com'
});

const firestore = admin.firestore();

async function fixStInvoices() {
  // Find all invoices with empty driver or zero hours from today (3/30/2026)
  const snap = await firestore.collection('invoices')
    .where('status', '==', 'closed')
    .where('date', '==', '03/30/2026')
    .get();

  console.log(`Found ${snap.size} closed invoices from 03/30/2026`);

  for (const doc of snap.docs) {
    const d = doc.data();
    const updates: Record<string, any> = {};
    let changed = false;

    // Fix hours: recalculate from invoiceStartedAt + closedAt
    if ((!d.totalHours || d.totalHours === 0) && d.invoiceStartedAt && d.closedAt) {
      const startMs = new Date(d.invoiceStartedAt).getTime();
      const closeMs = d.closedAt.toDate ? d.closedAt.toDate().getTime() : new Date(d.closedAt).getTime();
      if (!isNaN(startMs) && !isNaN(closeMs) && closeMs > startMs) {
        const hours = Math.round(((closeMs - startMs) / 3600000) * 100) / 100;
        updates.totalHours = hours;
        console.log(`  [${doc.id}] Hours: 0 → ${hours} (${d.invoiceStartedAt} to ${d.closedAt})`);
        changed = true;
      }
    }

    // Fix driver: resolve from dispatchId
    if (!d.driver && d.dispatchId) {
      try {
        const dispDoc = await firestore.collection('dispatches').doc(d.dispatchId).get();
        if (dispDoc.exists) {
          const disp = dispDoc.data()!;
          const driverName = disp.driverName || '';
          if (driverName) {
            updates.driver = driverName;
            console.log(`  [${doc.id}] Driver: '' → '${driverName}'`);
            changed = true;
          }

          // Also grab driver hash to resolve legalName from RTDB
          if (disp.driverHash) {
            try {
              const rtdbSnap = await admin.database().ref(`drivers/approved/${disp.driverHash}`).once('value');
              const driverData = rtdbSnap.val();
              if (driverData) {
                const legalName = driverData.legalName || driverData.profile?.legalName;
                if (legalName) {
                  updates.driver = legalName;
                  console.log(`  [${doc.id}] Driver upgraded to legalName: '${legalName}'`);
                }
              }
            } catch (err) {
              // Non-fatal — display name is fine
            }
          }
        }
      } catch (err) {
        console.warn(`  [${doc.id}] Failed to resolve driver from dispatch ${d.dispatchId}:`, err);
      }
    }

    // Fix driver for non-dispatch jobs (manual/LDS) — check RTDB by looking at who created it
    if (!d.driver && !d.dispatchId) {
      console.log(`  [${doc.id}] No driver and no dispatchId — cannot resolve (manual job without driver field)`);
    }

    if (changed) {
      await firestore.collection('invoices').doc(doc.id).update(updates);
      console.log(`  [${doc.id}] ✅ Patched: ${JSON.stringify(updates)}`);
    } else {
      console.log(`  [${doc.id}] — no changes needed (driver: '${d.driver}', hours: ${d.totalHours})`);
    }
  }

  console.log('\nDone!');
  process.exit(0);
}

fixStInvoices().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
