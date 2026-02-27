const admin = require('firebase-admin');
const sa = require('../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com' });
const db = admin.database();

async function cleanup() {
  const wellsSnap = await db.ref('wells').once('value');
  const wellsData = wellsSnap.val() || {};

  const procSnap = await db.ref('packets/processed').once('value');
  const procData = procSnap.val() || {};
  const processedIds = new Set(Object.keys(procData));

  // Also get well configs for tank info
  const configSnap = await db.ref('well_config').once('value');
  const configs = configSnap.val() || {};

  let copied = 0;
  let skipped = 0;

  for (const [wellName, wellData] of Object.entries(wellsData)) {
    if (!wellData || typeof wellData !== 'object' || !wellData.history) continue;
    const history = wellData.history;

    for (const [ts, entry] of Object.entries(history)) {
      if (!entry.packetId || processedIds.has(entry.packetId)) continue;

      // Skip test well mock data
      if (wellName === 'Test Well' && entry.packetId.startsWith('mock_')) {
        skipped++;
        console.log('SKIP (mock): ' + wellName + ' / ' + entry.packetId);
        continue;
      }

      // Convert history format to processed format
      const tanks = configs[wellName] ? (configs[wellName].tanks || configs[wellName].numTanks || 1) : 1;
      const topInches = entry.topLevelInches || 0;
      const bottomInches = entry.bottomLevelInches || 0;

      const processedPacket = {
        wellName: wellName,
        packetId: entry.packetId,
        dateTime: entry.dateTime || '',
        dateTimeUTC: entry.dateTimeUTC || '',
        tankTopInches: topInches,
        tankLevelFeet: topInches / 12,
        tankAfterInches: bottomInches,
        tankAfterFeet: bottomInches > 0 ? Math.floor(bottomInches / 12) + "'" + Math.floor(bottomInches % 12) + '"' : '',
        bblsTaken: entry.bblsTaken || 0,
        driverName: entry.driverName || '',
        timeDif: entry.timeDif || '',
        timeDifDays: entry.timeDifDays || 0,
        recoveryInches: entry.recoveryInches || 0,
        flowRate: entry.flowRate || '',
        flowRateDays: entry.flowRateDays || 0,
        processedAt: entry.processedAt || new Date().toISOString(),
      };

      console.log('COPY: ' + wellName + ' / ' + entry.packetId + ' @ ' + entry.dateTimeUTC);
      await db.ref('packets/processed/' + entry.packetId).set(processedPacket);
      copied++;
    }
  }

  console.log('\nCopied ' + copied + ' entries to packets/processed');
  console.log('Skipped ' + skipped + ' mock entries');

  // Now delete all history paths
  let deletedWells = 0;
  for (const [wellName, wellData] of Object.entries(wellsData)) {
    if (!wellData || typeof wellData !== 'object' || !wellData.history) continue;
    await db.ref('wells/' + wellName + '/history').remove();
    deletedWells++;
    console.log('DELETED: wells/' + wellName + '/history');
  }

  console.log('\nDeleted history from ' + deletedWells + ' wells');
  console.log('Done!');
  process.exit(0);
}

cleanup().catch(e => { console.error(e); process.exit(1); });
