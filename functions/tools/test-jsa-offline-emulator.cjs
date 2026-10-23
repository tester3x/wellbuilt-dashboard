const assert=require('node:assert/strict');
if(!process.env.FIRESTORE_EMULATOR_HOST||!String(process.env.GCLOUD_PROJECT||'').startsWith('demo-'))throw Error('This test requires an explicitly isolated demo Firestore emulator.');
const admin=require('firebase-admin');admin.initializeApp({projectId:process.env.GCLOUD_PROJECT});const db=admin.firestore();
// Real compiled callable, validators, artifact parser and Firestore transactions.
// Only external identity/policy readers are fixtures; no live Auth/RTDB traffic.
function port(path,exports){const filename=require.resolve(path);require.cache[filename]={id:filename,filename,loaded:true,exports};}
port('../lib/sso/ssoCallables',{buildSsoDeps:()=>({getDriver:async id=>({active:true,driverId:id,companyId:'test-company'})})});
port('../lib/security/rateLimit',{checkRateLimit:async()=>true});
port('../lib/jsaReceipt/jsaReceiptCallables',{jobDayDeps:()=>({})});
const {jsaOfflineShift}=require('../lib/jsaReceipt/jsaOfflineCallable');
const {fromStored}=require('../lib/jsaReceipt/jsaReceiptCore');
const {offlineHash}=require('../lib/jsaReceipt/jsaOfflineCore');
const now=Date.now(),periodId='b'.repeat(48),grantId='a'.repeat(64);
const owner={companyId:'test-company',driverId:'test-driver'};
const grant={version:1,id:grantId,...owner,issuedAtMs:now-10000,expiresAtMs:now+86400000,shiftId:'2026-10-23_090000',binding:{shiftState:'independent',policyDay:'2026-10-23',jsaPeriodId:periodId,associatedPeriodId:'2026-10-23_090000',jsaEnabled:true,requiresActiveShift:false},requirementKey:'jsa:'+periodId,policyDay:'2026-10-23',mode:'per_job',allowAcknowledge:true,operators:['Operator A','Operator B'],fullReadId:null,assessments:[{name:'Fixture JSA',contentHash:'c'.repeat(64),packageId:null,tasks:[],steps:[{id:'step'}],preparedItems:[{id:'prepared'}],ppeItems:[]}]};
const signed={prepared:{prepared:true},locationAcks:{},locations:[],stepsAcknowledged:true,stepAcks:{step:true},ppeSelected:{},ppeOtherItems:[],notes:'Emulator only',pusher:'',otherInfo:'',printedName:'Software Test Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}};
const auth={uid:'test-driver-uid',token:{kind:'driver',app:'wbt',...owner}};
const commit=(event,override=auth)=>jsaOfflineShift.run({auth:override,data:{version:1,operation:'commit',event}});
const event=(id,jobRef,kind,details={})=>({version:1,id:id.repeat(43),grantId,jobRef,operator:jobRef==='job-b'?'Operator B':'Operator A',occurredAtMs:now-1000,kind,...details});
(async()=>{
 await db.doc('jsa_offline_grants/'+grantId).set(grant);
 await db.doc('jsa_work_periods/'+periodId).set({id:periodId,...owner,shiftId:grant.shiftId,state:'open'});
 for(const [id,operator] of [['job-a','Operator A'],['job-b','Operator B'],['job-foreign','Operator A']])await db.doc('invoices/'+id).set({companyId:id==='job-foreign'?'foreign':owner.companyId,driverId:owner.driverId,operator,wellName:'Test Well',commodityType:'Service Work'});
 await assert.rejects(commit(event('X','job-a','read',{assessmentHash:'c'.repeat(64),snapshot:signed}),null));
 const full=event('R','job-a','read',{assessmentHash:'c'.repeat(64),snapshot:signed});
 const results=await Promise.all([commit(full),commit(full),commit(full)]);
 assert(results.every(r=>r.state==='confirmed'&&r.eventHash===offlineHash(full)));
 const stored=fromStored((await db.doc('jsa_governed_requests/'+full.id).get()).data());assert(stored&&stored.action==='read_and_acknowledged');
 assert.equal((await db.doc('jsa_governed_artifacts/'+full.id).get()).get('snapshot.printedName'),'Software Test Driver');
 assert.equal((await db.collection('jsa_offline_receipts').get()).size,1);
 const ack=event('A','job-b','acknowledged',{fullReadId:full.id});const response=await commit(ack);assert.equal(response.state,'confirmed');
 assert.equal((await db.doc('jsa_job_acknowledgments/'+response.recordId).get()).get('recordedAtMs'),ack.occurredAtMs);
 await assert.rejects(commit({...ack,occurredAtMs:now-500}),/needs review/);
 await assert.rejects(commit(event('F','job-foreign','acknowledged',{fullReadId:full.id})),/needs review/);
 await assert.rejects(commit(event('U','job-b','acknowledged',{fullReadId:'N'.repeat(43)})),/needs review/);
 await assert.rejects(commit(event('I','job-b','read',{assessmentHash:'c'.repeat(64),snapshot:{...signed,prepared:{prepared:false}}})),/needs review/);
 await assert.rejects(commit(event('S','job-b','scope_read',{fullReadId:full.id})),/needs review/);
 await db.doc('jsa_work_periods/'+periodId).update({state:'finalized',finalizedAtMs:now-500});
 const historical=event('H','job-b','acknowledged',{fullReadId:full.id});assert.equal((await commit(historical)).state,'confirmed');
 await assert.rejects(commit({...event('L','job-b','acknowledged',{fullReadId:full.id}),occurredAtMs:now}),/needs review/);
 assert.equal((await db.collection('jsa_governed_requests').get()).size,1,'No duplicate read');
 assert.equal((await db.collection('jsa_governed_artifacts').get()).size,1,'No duplicate signature');
 assert.equal((await db.collection('jsa_job_acknowledgments').get()).size,1,'One exact job/work-period coverage');
 assert.equal((await db.collection('jsa_offline_receipts').get()).size,3,'Only confirmed actions get receipts');
 console.log('Compiled offline callable: concurrent retries, signed artifact, exact server receipts, immutable IDs, owner/scope validation and late shift replay passed. Emulator only.');
})().finally(()=>db.terminate()).catch(e=>{console.error(e);process.exitCode=1;});
