const admin = require('firebase-admin');
const sa = require('C:/dev/wellbuilt-dashboard/serviceAccountKey.json');
admin.initializeApp({ 
  credential: admin.credential.cert(sa),
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com'
});
const rtdb = admin.database();

async function run() {
  const snap = await rtdb.ref('packets/processed')
    .orderByChild('wellName')
    .equalTo('Gabriel 6')
    .once('value');
  
  const packets = snap.val() || {};
  const sorted = Object.entries(packets)
    .map(([key, val]) => ({ key, ...val }))
    .sort((a, b) => (b.dateTimeUTC || '').localeCompare(a.dateTimeUTC || ''));
  
  console.log(`Found ${sorted.length} processed packets for Gabriel 6\n`);
  
  for (const p of sorted.slice(0, 5)) {
    console.log(`========== ${p.key} ==========`);
    console.log(`  dateTime:      ${p.dateTime}`);
    console.log(`  dateTimeUTC:   ${p.dateTimeUTC}`);
    console.log(`  tankLevelFeet: ${p.tankLevelFeet}`);
    console.log(`  bblsTaken:     ${p.bblsTaken}`);
    console.log(`  driverName:    ${p.driverName}`);
    console.log(`  source:        ${p.source || '(none)'}`);
    console.log(`  jobOrigin:     ${p.jobOrigin || '(none)'}`);
    console.log(`  wasEdited:     ${p.wasEdited || false}`);
    console.log(`  editedByPacketId: ${p.editedByPacketId || '(none)'}`);
    console.log(`  packetId:      ${p.packetId}`);
    console.log('');
  }

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
