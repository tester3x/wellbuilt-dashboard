const assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {manageJsaTemplate}=require('../lib/jsaReceipt/jsaTemplateManagement');
const {authorizeTemplateStaff}=require('../lib/jsaReceipt/jsaTemplateManagementCallable');
const {readJsaTaskCatalog,selectJsaTaskTemplates}=require('../lib/jsaReceipt/jsaTaskCatalog');
const {handleStandalone}=require('../lib/jsaReceipt/jsaStandalone');
if(!process.env.FIRESTORE_EMULATOR_HOST)throw Error('Emulator required; never run on production');
admin.initializeApp({projectId:'demo-jsa-standalone'});const db=admin.firestore();
const get=async p=>{const s=await db.doc(p).get();return s.exists?s.data():null};
const company='flow-company',driver='flow-driver';let count=0;
const check=(v)=>{assert.ok(v);count++};
const manage=(operation,templateId,data)=>db.runTransaction(async t=>{
 const tx={get:async p=>{const s=await t.get(db.doc(p));return s.exists?s.data():null},list:async p=>(await t.get(db.collection(p))).docs.map(d=>({id:d.id,data:d.data()})),set:(p,d)=>t.set(db.doc(p),d),delete:p=>t.delete(db.doc(p))};
 await authorizeTemplateStaff(tx.get,{uid:'fixture-manager',token:{}},company);
 return manageJsaTemplate(tx,{operation,templateId,companyId:company,...(data?{data}:{})},'fixture-manager','2026-09-15T00:00:00Z');
});
const store={readRecord:get,readTemplate:get,readCatalog:c=>db.runTransaction(async t=>readJsaTaskCatalog({readTemplate:async p=>{const s=await t.get(db.doc(p));return s.exists?s.data():null}},c)),list:async p=>(await db.collection(p).get()).docs.map(d=>d.data()),transaction:(p,fn)=>db.runTransaction(async t=>{const r=db.doc(p),s=await t.get(r),old=s.exists?s.data():null,next=fn(old);if(next)t.set(r,next);return next||old})};
const auth={uid:'fixture-driver',claims:{kind:'driver',driverId:driver,companyId:company,app:'jsa'}};
const contract={contractVersion:1,planId:'free',contractEnforced:true};
const deps={getDriver:async()=>({driverId:driver,companyId:company,active:true}),getCompanyContract:async()=>({state:'active',contract}),getPlan:async()=>({contractVersion:1,planId:'free',displayName:'Free',capabilities:['jsa'],status:'active',apps:{'wellbuilt-jsa':{included:true}}})};
const run=(body,now=1000)=>handleStandalone(deps,store,auth,body,now);
(async()=>{
 await db.doc('staff/fixture-manager').set({enabled:true,role:'manager',companyId:company});
 for(const name of ['Loading','Unloading']){
   const id=name.toLowerCase();await manage('save',id,{name,tasks:[id],steps:[{id:'s1',title:'Exact '+name,items:[{hazard:'Exact hazard',controls:'Exact control'}]}],ppeItems:[],preparedItems:[]});await manage('publish',id);
 }
 const catalog=await run({operation:'templates'});check(catalog.templates.length===2);
 const ref=t=>({id:t.id,version:t.version,contentHash:t.contentHash});
 const loading=selectJsaTaskTemplates(catalog,[ref(catalog.templates.find(t=>t.id==='loading'))]);
 const unloading=selectJsaTaskTemplates(catalog,[ref(catalog.templates.find(t=>t.id==='unloading'))]);
 const snapshot={prepared:{},locationAcks:{},locations:['Fixture well'],stepsAcknowledged:true,stepAcks:Object.fromEntries(loading.steps.map(s=>[s.id,true])),ppeSelected:{},ppeOtherItems:[],notes:'',pusher:'',otherInfo:'',printedName:'Fixture Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1,2,3]).toString('base64')},formDate:'2026-09-15'};
 const create={operation:'create',recordId:'T'.repeat(43),snapshot,job:{activity:'Loading',operator:'Fixture operator',wells:[{name:'Fixture well',jobType:'Loading',operator:'Fixture operator',county:''}],templateRefs:loading.templates.map(ref),assessmentSteps:loading.steps}};
 const saved=(await run(create)).record;check(saved.state==='open');check(saved.shiftId===null);assert.deepEqual(saved.job.assessmentSteps,loading.steps);count++;
 check((await run(create,2000)).record.signedAtMs===1000);
 const append={operation:'append',recordId:saved.id,additionId:'U'.repeat(43),addition:{location:'Fixture disposal',operator:'Fixture operator',activity:'Unloading',hazards:'Fixture hazard',controls:'Fixture control',ppe:'Fixture PPE',acknowledged:true,baseContentHash:saved.contentHash,expectedAdditionCount:0,taskReview:{templateRefs:unloading.templates.map(ref),stepAcks:Object.fromEntries(unloading.steps.map(s=>[s.id,true]))}}};
 const added=(await run(append,3000)).record;check(added.additions.length===1);check(added.additions[0].taskAssessment.steps[0].title==='Exact Unloading');assert.deepEqual(added.snapshot,saved.snapshot);count++;
 await manage('deactivate','unloading');await manage('deactivate','loading');
 check((await run(append,4000)).record.additions.length===1);check((await run(create,4000)).record.signedAtMs===1000);
 const closed=(await run({operation:'close',recordId:saved.id},5000)).record;check(closed.state==='closed');check((await run(append,6000)).record.additions[0].acknowledgedAtMs===3000);
 const unauth=await fetch('http://'+process.env.FIRESTORE_EMULATOR_HOST+'/v1/projects/demo-jsa-standalone/databases/(default)/documents/jsa_templates/'+company);check(unauth.status===403);
 const rawWrite=await fetch('http://'+process.env.FIRESTORE_EMULATOR_HOST+'/v1/projects/demo-jsa-standalone/databases/(default)/documents/jsa_templates/'+company+'/templates/forged',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{name:{stringValue:'forged'}}})});check(rawWrite.status===403);
 console.log(`${count} emulator flow checks passed: authorized publication → company catalog → standalone sign → new task → retirement retries → close; no production data`);
})().catch(e=>{console.error(e);process.exitCode=1});
