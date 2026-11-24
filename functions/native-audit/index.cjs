// Emulator fixture imports the actual compiled callable; no handler copy.
if(process.env.GCLOUD_PROJECT!=='demo-wb-audit-s24'||!process.env.FIRESTORE_EMULATOR_HOST||!process.env.FIREBASE_DATABASE_EMULATOR_HOST)throw Error('Local synthetic emulators required');
const admin=require('firebase-admin');
if(!admin.apps.length)admin.initializeApp({projectId:'demo-wb-audit-s24',databaseURL:'https://demo-wb-audit-s24-default-rtdb.firebaseio.com'});
exports.jsaLegacyEvidence=require('../lib/jsaReceipt/jsaLegacyEvidenceCallable').jsaLegacyEvidence;
