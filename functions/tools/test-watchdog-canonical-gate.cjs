// Reuses AntiGravity 028c6d4f's two-event fixture and canonical completion checks.
// Runs the UNMODIFIED deployed processor; never submits a production packet.
const assert = require('node:assert/strict');
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Both emulators required');
const projectId = 'demo-watchdog-canonical';
process.env.GCLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId, databaseURL:`https://${projectId}-default-rtdb.firebaseio.com`});
const admin = require('firebase-admin');
const { processIncomingPull } = require('../lib/index');
async function read(path) {
 const url=`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/${path}.json?ns=${projectId}-default-rtdb`;
 const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
 if(!response.ok) throw new Error('Emulator evidence read failed');
 return response.json();
}
(async()=>{
 const db=admin.database();
 await db.ref('well_config/Kahuna 5').set({wellName:'Kahuna 5',companyId:'liquid-gold',route:'Kahuna 381',tanks:10,bottomLevel:3,pullBbls:140,tankHeight:20,bblPerFoot:20});
 const events=[
  {packetId:'20260912_165700_Kahuna5_1ab68c',dateTimeUTC:'2026-09-12T21:57:00.000Z',top:7.5,bottom:6.7,bbl:150},
  {packetId:'20260912_174800_Kahuna5_aef41b',dateTimeUTC:'2026-09-12T22:48:00.000Z',top:6.7,bottom:6.0,bbl:140},
 ];
 const results=[];
 for(const e of events){
  const packet={packetId:e.packetId,idempotencyKey:e.packetId,requestType:'pull',wellName:'Kahuna 5',dateTimeUTC:e.dateTimeUTC,
   timezone:'America/Chicago',tankLevelFeet:e.top,bblsTaken:e.bbl,companyId:'liquid-gold',source:'whatsapp_watchdog'};
  const ref=db.ref('packets/incoming/'+e.packetId); await ref.set(packet);
  let error=null;
  let timer;
  try {await Promise.race([processIncomingPull.run(await ref.once('value'),{params:{packetId:e.packetId},eventId:'synthetic-'+e.packetId}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('canonical_processor_timeout_30000ms')),30000);})]);}
  catch(e){error=e.message;}
  finally {clearTimeout(timer);}
  const processed=await read('packets/processed/'+e.packetId);
  const status=await read('wells/Kahuna%205/status');
  const outgoing=await read('packets/outgoing');
  const expectedBottomInches=e.bottom*12;
  const row={packetId:e.packetId,expectedBottomInches,actualProcessedBottomInches:processed?.tankAfterInches??null,
   canonicalProcessingComplete:processed?.canonicalProcessingComplete===true,
   outgoingExists:!!outgoing,currentWellPacketId:status?.lastPull?.packetId??null,currentWellLevelInches:status?.current?.levelInches??null,error};
  results.push(row);
  if(error || !row.canonicalProcessingComplete || row.currentWellPacketId!==e.packetId || Math.abs(row.currentWellLevelInches-expectedBottomInches)>1e-8) break;
 }
 for(const collection of ['tickets','invoices','payroll','billing','billing_invoices','dispatches','jsa_day_status']) {
  assert.equal((await admin.firestore().collection(collection).get()).size,0,collection+' must remain empty');
 }
 console.log(JSON.stringify({processorChanged:false,eventsAttempted:results.length,results,commercialAndJsaCollectionsEmpty:true,productionWrites:0},null,2));
 // This is a diagnostic gate, not a passing acceptance suite.
 process.exitCode=results.length===2 && results.every(r=>!r.error&&r.canonicalProcessingComplete&&Math.abs(r.currentWellLevelInches-r.expectedBottomInches)<1e-8)?0:2;
 process.exit(process.exitCode || 0);
})().catch(e=>{console.error(e.message);process.exitCode=1});
