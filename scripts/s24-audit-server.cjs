// Local-only synthetic device harness. Never loads production Firebase config.
// Usage: node scripts/s24-audit-server.cjs JSA_HOME TICKETS_HOME
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const projectId='demo-wb-audit-s24';
Object.assign(process.env,{GCLOUD_PROJECT:projectId,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9299',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8183',FIREBASE_DATABASE_EMULATOR_HOST:'127.0.0.1:9190'});
const admin=require('../functions/node_modules/firebase-admin'),ts=require('../functions/node_modules/typescript');
admin.initializeApp({projectId,databaseURL:`https://${projectId}-default-rtdb.firebaseio.com`});
const db=admin.firestore();
const {jsaLegacyEvidence}=require('../functions/lib/jsaReceipt/jsaLegacyEvidenceCallable');
const {evidenceCanonical}=require('../functions/lib/jsaReceipt/jsaLegacyEvidence');
const tickets=path.resolve(process.argv[3]||''),jsa=path.resolve(process.argv[2]||'');
if(!fs.existsSync(path.join(jsa,'services/legacyEvidence.ts'))||!fs.existsSync(path.join(tickets,'utils/invoiceAllocation.ts')))throw Error('Pass registered source homes.');
const allocation=require(path.join(tickets,'functions/lib/invoiceAllocation.js'));
// Evaluate only the exact reviewed export adapter, not the unrelated index exports.
const index=fs.readFileSync(path.join(tickets,'functions/src/index.ts'),'utf8');
const adapter=index.slice(index.indexOf('export const assignInvoiceBlock ='),index.indexOf('/**\r\n * assignTicketBlock')>0?index.indexOf('/**\r\n * assignTicketBlock'):index.indexOf('/**\n * assignTicketBlock'));
if(!adapter||!adapter.includes('allocateInvoiceBlock'))throw Error('Allocation adapter boundary changed');
const m={exports:{}};
new Function('module','exports','functionsV1','allocateInvoiceBlock','InvoiceAllocationError','db','process',ts.transpileModule(adapter,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m,m.exports,{https:{onCall:f=>f,HttpsError:class extends Error{constructor(code,msg){super(msg);this.code=code;}}}},allocation.allocateInvoiceBlock,allocation.InvoiceAllocationError,db,{env:{FUNCTIONS_EMULATOR:'true'}});
const modules={evidence:path.join(jsa,'services/legacyEvidence.ts'),evidenceCore:path.join(jsa,'services/legacyEvidenceCore.ts'),invoice:path.join(tickets,'utils/invoiceAllocation.ts')};
const sources=Object.fromEntries(Object.entries(modules).map(([k,file])=>[k,{sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),code:ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText}]));
const run='s24-'+crypto.randomBytes(8).toString('hex'),now=Date.now(),requestId=crypto.randomBytes(32).toString('base64url');
const identities={},counts={rpc:0,failures:0,receiptDropped:0};let seeded=false;
async function seed(){
 if(seeded)return;seeded=true;
 for(const company of ['a','b']){
  const companyId=run+'-'+company,driverId=companyId+'-driver';
  await db.doc('companies/'+companyId).set({active:true,invoicePrefix:company.toUpperCase(),invoiceStartNumber:1000,jsaMode:'per_job',jsaJobPolicy:'read_and_acknowledge',wellbuiltContract:{contractVersion:1,configurationVersion:1,planId:'native-audit',entitlementOverrides:[],contractEnforced:true}});
  await db.doc('driver_credentials/'+driverId).set({active:true});
  await admin.database().ref('drivers/profiles/'+driverId).set({active:true,companyId,displayName:'Synthetic Test Driver'});
  identities[company]={};
  for(const app of ['jsa','wbt']){
   const uid=companyId+'-'+app,claims={kind:'driver',app,companyId,driverId};
   await admin.auth().createUser({uid});
   const custom=await admin.auth().createCustomToken(uid,claims);
   const result=await fetch(`http://127.0.0.1:9299/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:custom,returnSecureToken:true})}).then(r=>r.json());
   if(!result.idToken)throw Error('Synthetic auth failed');
   identities[company][app]={uid,companyId,driverId,generation:1,token:result.idToken,customToken:custom};
  }
 }
 await db.doc('plans/native-audit').set({contractVersion:1,planId:'native-audit',displayName:'Synthetic emulator only',capabilities:['jsa'],status:'active',apps:{'wellbuilt-jsa':{included:true,requiresActiveShift:false}}});
 await db.doc('driver_shift_authority/'+identities.a.jsa.driverId).set({driverId:identities.a.jsa.driverId,companyId:identities.a.jsa.companyId,initialized:true,version:1,openPeriodId:null,originLocalDate:null});
 await db.doc('invoices/'+run+'-job').set({companyId:identities.a.jsa.companyId,driverId:identities.a.jsa.driverId,shiftId:run+'-shift',wellName:'AUDIT WELL ONLY',operator:'Synthetic Operator',commodityType:'Production Water'});
}
const original=()=>({id:'legacy_'+requestId,companyId:identities.a.jsa.companyId,driverId:identities.a.jsa.driverId,driverHash:identities.a.jsa.driverId,timestamp:new Date(now).toISOString(),signature:'Synthetic signature only',shiftId:run+'-shift',legacyReceiptBinding:{requestId,companyId:identities.a.jsa.companyId,driverHash:identities.a.jsa.driverId,jobDocId:run+'-job',shiftId:run+'-shift',receiptVersion:1,receivedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString()}});
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>700000)throw Error('size');}return JSON.parse(s||'{}');}
const server=http.createServer(async(req,res)=>{
 try{
  if(!/^127\.0\.0\.1:8789$/.test(req.headers.host||''))return json(res,403,{error:'loopback_only'});
  const url=new URL(req.url,'http://127.0.0.1:8789');
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'"});return res.end(fs.readFileSync(path.join(__dirname,'s24-audit.html')));}
  if(req.method==='GET'&&url.pathname==='/client.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(__dirname,'s24-audit-client.js')));}
  if(req.method==='GET'&&url.pathname==='/bootstrap'){await seed();return json(res,200,{projectId,run,identities,record:original(),sources});}
  if(req.method==='GET'&&url.pathname==='/guided-proof'){
   await seed();const rows=await db.collection('jsa_governed_requests').where('companyId','==',identities.a.jsa.companyId).get();
   const artifacts=await db.collection('jsa_governed_artifacts').where('companyId','==',identities.a.jsa.companyId).get();
   return json(res,200,{requests:rows.docs.map(d=>({id:d.id,...d.data()})),artifactCount:artifacts.size,artifactHashes:artifacts.docs.map(d=>d.data().snapshotHash)});
  }
  if(req.method==='POST'&&url.pathname.startsWith('/rpc/')){
   const token=(req.headers.authorization||'').replace(/^Bearer /,'');
   const decoded=await admin.auth().verifyIdToken(token);if(!decoded.uid.startsWith(run+'-'))throw Error('synthetic_only');
   const data=await body(req);counts.rpc++;
   let result;
   if(url.pathname==='/rpc/jsaLegacyEvidence')result=await jsaLegacyEvidence.run({data,auth:{uid:decoded.uid,token:decoded}});
   else if(url.pathname==='/rpc/assignInvoiceBlock')result=await m.exports.assignInvoiceBlock(data,{auth:{uid:decoded.uid,token:decoded}});
   else throw Error('unknown_rpc');
   // A bounded error after commit is deterministic. A bare socket close may be
   // transparently retried by Chrome before JS can observe the lost response.
   if(req.headers['x-test-drop-receipt']==='once'&&data.operation==='receipt'&&!counts.receiptDropped){counts.receiptDropped++;return json(res,503,{error:'synthetic_lost_receipt_ack'});}
   return json(res,200,{data:result});
  }
  if(req.method==='GET'&&url.pathname==='/verify'){
   const record=original(),saved=(await db.doc('jsas/'+record.id).get()).data(),receipt=(await db.doc('jsa_read_receipts/'+requestId).get()).data();
   const blocks=await db.collection('invoiceBlocks').where('companyId','==',identities.a.jsa.companyId).get();
   const allSigned=await db.collection('jsas').where('companyId','==',record.companyId).get();
   return json(res,200,{counts,originalUnchanged:!!saved&&evidenceCanonical(saved)===evidenceCanonical(record),signedCount:allSigned.size,receiptCount:receipt?1:0,receiptTimeUnchanged:receipt?.completedAt===record.timestamp,companyABlocks:blocks.size});
  }
  if(req.method==='POST'&&url.pathname==='/result'){const r=await body(req);console.log(JSON.stringify({run,result:r}));return json(res,200,{ok:true});}
  json(res,404,{error:'not_found'});
 }catch(e){counts.failures++;json(res,403,{error:String(e.code||e.message||'refused')});}
});
server.listen(8789,'127.0.0.1',()=>console.log('Synthetic S24 harness ready at loopback port 8789; demo emulators only.'));
