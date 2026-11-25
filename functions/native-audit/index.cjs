// Emulator fixture imports the actual compiled callable; no handler copy.
if(process.env.GCLOUD_PROJECT!=='demo-wb-audit-s24'||!process.env.FIRESTORE_EMULATOR_HOST||!process.env.FIREBASE_DATABASE_EMULATOR_HOST)throw Error('Local synthetic emulators required');
const admin=require('firebase-admin');
if(!admin.apps.length)admin.initializeApp({projectId:'demo-wb-audit-s24',databaseURL:'https://demo-wb-audit-s24-default-rtdb.firebaseio.com'});
exports.jsaLegacyEvidence=require('../lib/jsaReceipt/jsaLegacyEvidenceCallable').jsaLegacyEvidence;
exports.submitJsaRecord=require('../lib/security/operational/jsaWrite').submitJsaRecord;
// Actual governed callable wrappers, exposed only by this demo-only fixture.
const governed=require('../lib/jsaReceipt/jsaReceiptCallables');
for(const name of ['jsaResolveJobShiftEvidence','jsaRegisterJobShiftReadRequest','jsaGetReadRequest','jsaCompleteReadRequest','jsaPersistGovernedArtifact','jsaConsumeReadResult'])exports[name]=governed[name];

// Capture compiled-source identity when this emulator fixture loads, so a
// passing acceptance run cannot silently use an older warmed worker.
const fs=require('node:fs'),crypto=require('node:crypto');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(require.resolve(file))).digest('hex');
const backendSource={project:process.env.GCLOUD_PROJECT,wrapper:digest('../lib/jsaReceipt/jsaLegacyEvidenceCallable'),core:digest('../lib/jsaReceipt/jsaLegacyEvidence'),compatibility:digest('../lib/security/operational/jsaWrite')};
exports.jsaAuditSourceProof=require('firebase-functions/v2/https').onRequest((_req,res)=>res.json(backendSource));
