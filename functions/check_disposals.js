const admin = require('firebase-admin');
const sa = require('C:/dev/wellbuilt-dashboard/serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

async function run() {
  const snap = await db.collection('disposals').limit(5).get();
  console.log(`Found ${snap.size} disposals (showing first 5)\n`);
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`${doc.id}: ${d.well_name}`);
    console.log(`  latitude: ${d.latitude} (${typeof d.latitude})`);
    console.log(`  longitude: ${d.longitude} (${typeof d.longitude})`);
    console.log(`  lat: ${d.lat} (${typeof d.lat})`);
    console.log(`  lng: ${d.lng} (${typeof d.lng})`);
    console.log(`  gpsLat: ${d.gpsLat} (${typeof d.gpsLat})`);
    console.log(`  All fields: ${Object.keys(d).join(', ')}`);
    console.log('');
  });
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
