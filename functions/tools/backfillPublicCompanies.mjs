/**
 * Controlled backfill: companies/{id} → public_companies/{id}.
 *
 * REFUSES production. Runs only against the Firestore emulator
 * (FIRESTORE_EMULATOR_HOST must be set). Do not invoke this against
 * wellbuilt-sync live data.
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node functions/tools/backfillPublicCompanies.mjs
 *
 * This script is a utility. Phase 1A does not execute it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const COPIED = ['name', 'status', 'tier', 'logoUrl', 'thermalLogoUrl', 'primaryColor'];
const SENSITIVE = [
  'address', 'city', 'state', 'zip', 'phone',
  'rateSheet', 'rateSheets', 'payConfig', 'billingConfig',
  'roleCapabilities', 'wellbuiltContract', 'assignedOperators',
];

function refuse(reason) {
  console.error(`REFUSED: ${reason}`);
  process.exit(2);
}

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  refuse('backfillPublicCompanies only runs against the Firestore emulator (set FIRESTORE_EMULATOR_HOST). Production is forbidden.');
}
if (process.argv.includes('--production') || process.argv.includes('--live')) {
  refuse('--production / --live flags are not accepted.');
}

const projectId = process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT_ID || 'demo-wellbuilt';
if (projectId === 'wellbuilt-sync' && !process.env.FIRESTORE_EMULATOR_HOST) {
  refuse('refusing wellbuilt-sync without an emulator host.');
}

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

function projectFields(data) {
  const out = {};
  for (const key of COPIED) {
    const value = data?.[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  for (const key of SENSITIVE) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      refuse(`projector leaked ${key}`);
    }
  }
  out.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  return out;
}

const db = admin.firestore();
const snap = await db.collection('companies').get();
let projected = 0;
for (const doc of snap.docs) {
  const payload = projectFields(doc.data() || {});
  await db.collection('public_companies').doc(doc.id).set(payload, { merge: false });
  projected++;
}
console.log(`emulator backfill complete: ${projected} public_companies documents (merge:false)`);
