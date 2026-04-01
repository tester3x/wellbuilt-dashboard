const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com'
});

const db = admin.firestore();
const rtdb = admin.database();

function printSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function printField(label, value) {
  if (value === undefined) {
    console.log(`  ${label}: (undefined)`);
  } else if (value === null) {
    console.log(`  ${label}: (null)`);
  } else if (typeof value === 'object' && value._seconds !== undefined) {
    // Firestore Timestamp
    const d = new Date(value._seconds * 1000);
    console.log(`  ${label}: ${d.toISOString()} (${d.toLocaleString('en-US', {timeZone: 'America/Chicago'})} CT)`);
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    console.log(`  ${label}:`);
    for (const [k, v] of Object.entries(value)) {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
  } else {
    console.log(`  ${label}: ${JSON.stringify(value)}`);
  }
}

async function main() {
  try {
    // 1. Query most recent closed invoice
    printSection('MOST RECENT CLOSED INVOICE');

    // Order by closedAt desc (no composite index needed)
    let snap = await db.collection('invoices')
      .orderBy('closedAt', 'desc')
      .limit(10)
      .get();

    if (snap.empty) {
      console.log('  No invoices found at all.');
      process.exit(0);
    }

    // Show the top 5 briefly
    console.log('\n  Top 5 most recent invoices by closedAt:');
    snap.docs.forEach((doc, i) => {
      const d = doc.data();
      const closedAt = d.closedAt ? new Date(d.closedAt._seconds * 1000).toLocaleString('en-US', {timeZone: 'America/Chicago'}) : '(none)';
      console.log(`    ${i+1}. ${doc.id} | ${d.driver || '?'} | ${d.wellName || '?'} | status=${d.status} | closedAt=${closedAt}`);
    });

    // Pick the first one (most recent)
    const invoiceDoc = snap.docs[0];
    const inv = invoiceDoc.data();
    const invoiceId = invoiceDoc.id;

    printSection(`INVOICE DETAIL: ${invoiceId}`);

    // Print key fields
    const keyFields = [
      'driver', 'driverHash', 'companyId', 'companyName',
      'totalHours', 'totalBBL', 'county', 'swdWaitMinutes', 'driveDistanceMiles',
      'invoiceStartedAt', 'closedAt', 'startTime', 'stopTime',
      'invoicingMode', 'dispatchId', 'invoiceNumber',
      'status', 'wellName', 'ndicWellName', 'operator', 'hauledTo',
      'commodityType', 'driverState', 'state', 'notes',
      'packageId', 'jobType', 'date',
      'apiNo', 'legalDesc', 'wellLocation',
      'ticketNumber', 'bbls', 'top', 'bottom',
      'driveMiles', 'loadCount', 'loadsCompleted',
      'splitGroupId', 'haulGroupId',
    ];

    for (const f of keyFields) {
      printField(f, inv[f]);
    }

    // Print tickets array
    printSection('TICKETS ARRAY');
    if (inv.tickets && inv.tickets.length > 0) {
      inv.tickets.forEach((t, i) => {
        console.log(`\n  --- Ticket ${i+1} ---`);
        for (const [k, v] of Object.entries(t)) {
          printField(k, v);
        }
      });
    } else {
      console.log('  No tickets in array. Checking ticketNumber field...');
      if (inv.ticketNumber) console.log(`  ticketNumber: ${inv.ticketNumber}`);
    }

    // Print timeline
    printSection('TIMELINE');
    if (inv.timeline && inv.timeline.length > 0) {
      inv.timeline.forEach((evt, i) => {
        const ts = evt.timestamp || evt.time || evt.at;
        console.log(`  ${i+1}. ${evt.type || evt.event || '?'} @ ${ts || '?'}`);
        // Print other fields
        for (const [k, v] of Object.entries(evt)) {
          if (k !== 'type' && k !== 'event' && k !== 'timestamp' && k !== 'time' && k !== 'at') {
            console.log(`     ${k}: ${JSON.stringify(v)}`);
          }
        }
      });
    } else {
      console.log('  No timeline array found.');
    }

    // Print ALL remaining fields not already printed
    printSection('ALL OTHER FIELDS');
    const printed = new Set([...keyFields, 'tickets', 'timeline']);
    for (const [k, v] of Object.entries(inv)) {
      if (!printed.has(k)) {
        printField(k, v);
      }
    }

    // 2. Check dispatch
    if (inv.dispatchId) {
      printSection(`DISPATCH: ${inv.dispatchId}`);
      const dispDoc = await db.collection('dispatches').doc(inv.dispatchId).get();
      if (dispDoc.exists) {
        const disp = dispDoc.data();
        const dispFields = [
          'status', 'completedAt', 'totalBBL', 'ticketNumber',
          'invoiceNumber', 'invoiceDocId', 'driver', 'driverName',
          'invoicingMode', 'driverStage', 'wellName', 'operator',
          'hauledTo', 'disposal', 'packageId', 'jobType',
          'loadCount', 'loadsCompleted', 'companyId',
        ];
        for (const f of dispFields) {
          printField(f, disp[f]);
        }
        // All other dispatch fields
        console.log('\n  --- Other dispatch fields ---');
        const dpPrinted = new Set(dispFields);
        for (const [k, v] of Object.entries(disp)) {
          if (!dpPrinted.has(k)) {
            printField(k, v);
          }
        }
      } else {
        console.log('  Dispatch doc not found.');
      }
    }

    // 3. Check tickets collection
    const ticketNumbers = [];
    if (inv.tickets && inv.tickets.length > 0) {
      inv.tickets.forEach(t => {
        if (t.ticketNumber) ticketNumbers.push(t.ticketNumber);
      });
    }
    if (inv.ticketNumber && !ticketNumbers.includes(inv.ticketNumber)) {
      ticketNumbers.push(inv.ticketNumber);
    }

    if (ticketNumbers.length > 0) {
      printSection('TICKETS COLLECTION LOOKUP');
      for (const tn of ticketNumbers) {
        console.log(`\n  --- Looking up ticket# ${tn} ---`);
        const tSnap = await db.collection('tickets')
          .where('ticketNumber', '==', tn)
          .limit(1)
          .get();
        if (!tSnap.empty) {
          const tData = tSnap.docs[0].data();
          const tFields = ['ticketNumber', 'qty', 'bbls', 'county', 'apiNo', 'legalDesc', 'operator', 'wellName', 'hauledTo', 'top', 'bottom', 'status'];
          for (const f of tFields) {
            printField(f, tData[f]);
          }
        } else {
          // Try as number
          const tSnap2 = await db.collection('tickets')
            .where('ticketNumber', '==', Number(tn))
            .limit(1)
            .get();
          if (!tSnap2.empty) {
            const tData = tSnap2.docs[0].data();
            for (const [k, v] of Object.entries(tData)) {
              printField(k, v);
            }
          } else {
            console.log(`  Not found in tickets collection.`);
          }
        }
      }
    }

    // 4. Check RTDB packets/incoming for GABRIEL
    printSection('RTDB: RECENT PACKETS FOR GABRIEL 7-36-25TFH');
    const incomingRef = rtdb.ref('packets/incoming');
    const incomingSnap = await incomingRef.orderByKey().limitToLast(50).once('value');
    const incomingData = incomingSnap.val();

    if (incomingData) {
      let found = 0;
      for (const [key, val] of Object.entries(incomingData)) {
        const str = JSON.stringify(val);
        if (str.includes('GABRIEL') || str.includes('gabriel')) {
          found++;
          console.log(`\n  Key: ${key}`);
          if (typeof val === 'object') {
            for (const [k, v] of Object.entries(val)) {
              printField(k, v);
            }
          } else {
            console.log(`  Value: ${JSON.stringify(val)}`);
          }
        }
      }
      if (found === 0) {
        console.log('  No GABRIEL packets in last 50 incoming packets.');
        // Check processed too
        console.log('\n  Checking packets/processed...');
        const procRef = rtdb.ref('packets/processed');
        const procSnap = await procRef.orderByKey().limitToLast(30).once('value');
        const procData = procSnap.val();
        if (procData) {
          let pFound = 0;
          for (const [key, val] of Object.entries(procData)) {
            const str = JSON.stringify(val);
            if (str.includes('GABRIEL') || str.includes('gabriel')) {
              pFound++;
              console.log(`\n  Key: ${key}`);
              if (typeof val === 'object') {
                for (const [k, v] of Object.entries(val)) {
                  printField(k, v);
                }
              }
            }
          }
          if (pFound === 0) console.log('  No GABRIEL packets in last 30 processed packets either.');
        }
      }
    } else {
      console.log('  No incoming packets found.');
    }

    // Also check if there's a pull packet sent by this job
    printSection('RTDB: OUTGOING PACKETS (last 30)');
    const outRef = rtdb.ref('packets/outgoing');
    const outSnap = await outRef.orderByKey().limitToLast(30).once('value');
    const outData = outSnap.val();
    if (outData) {
      let found = 0;
      for (const [key, val] of Object.entries(outData)) {
        const str = JSON.stringify(val);
        if (str.includes('GABRIEL') || str.includes('gabriel')) {
          found++;
          console.log(`\n  Key: ${key}`);
          if (typeof val === 'object') {
            for (const [k, v] of Object.entries(val)) {
              printField(k, v);
            }
          }
        }
      }
      if (found === 0) console.log('  No GABRIEL packets in last 30 outgoing packets.');
    }

    console.log('\n\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  }
}

main();
