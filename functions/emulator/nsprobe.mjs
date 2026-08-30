// Diagnostic: which namespace does the lib/index.js-style default app write to?
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({
  projectId: process.env.GCLOUD_PROJECT || 'wellbuilt-sync',
  databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${process.env.GCLOUD_PROJECT || 'wellbuilt-sync'}-default-rtdb`,
});
const mod = await import('../lib/index.js');
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
const db = admin.database();
console.log('[probe] app databaseURL option:', admin.app().options.databaseURL);
await db.ref('nsprobe').set({ at: Date.now() });
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002';
for (const ns of ['wellbuilt-sync-default-rtdb', 'wellbuilt-sync']) {
  const r = await fetch(`http://${host}/nsprobe.json?ns=${ns}`);
  console.log(`[probe] ns=${ns}:`, await r.text());
}
console.log('[probe] mod has watchdog:', typeof mod.watchdogStrandedPackets, 'run:', typeof mod.watchdogStrandedPackets?.run);
process.exit(0);
