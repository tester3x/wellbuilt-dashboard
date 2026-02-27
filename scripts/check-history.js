const admin = require('firebase-admin');
const sa = require('../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com' });
const db = admin.database();

async function check() {
  const wellsSnap = await db.ref('wells').once('value');
  const wellsData = wellsSnap.val() || {};

  const procSnap = await db.ref('packets/processed').once('value');
  const procData = procSnap.val() || {};
  const processedIds = new Set(Object.keys(procData));

  let totalHistEntries = 0;
  let totalOnlyInHistory = 0;

  for (const [wellName, wellData] of Object.entries(wellsData)) {
    if (!wellData || typeof wellData !== 'object' || !wellData.history) continue;
    const history = wellData.history;
    for (const [ts, entry] of Object.entries(history)) {
      totalHistEntries++;
      if (entry.packetId && !processedIds.has(entry.packetId)) {
        totalOnlyInHistory++;
        console.log('ONLY IN HISTORY: ' + wellName + ' / ' + entry.packetId + ' @ ' + entry.dateTimeUTC);
      }
    }
  }

  console.log('Total history entries across all wells: ' + totalHistEntries);
  console.log('Entries ONLY in history (not in processed): ' + totalOnlyInHistory);

  if (totalOnlyInHistory === 0) {
    console.log('All history entries exist in processed. Safe to delete history.');
  }

  process.exit(0);
}
check().catch(e => { console.error(e); process.exit(1); });
