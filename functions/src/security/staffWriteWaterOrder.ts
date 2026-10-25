import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {requireTrustedCompanyCapability} from './trustedStaffAuthority';

const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:any):string=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const invalid=(message:string):never=>{throw new https.HttpsError('invalid-argument',message);};

/** Saves advisory plans only; dispatch creation still uses staffWriteDispatch.
 * Acknowledgements require an actual company/driver/project-matching dispatch.
 * No client database write permission is granted. */
export const staffWriteWaterOrder=https.onCall({region:'us-central1',timeoutSeconds:60,memory:'256MiB'},async request=>{
 const trusted=await requireTrustedCompanyCapability(request.auth?.uid,'manageDrivers');
 const b=request.data;
 if(!object(b)||!['save','acknowledge'].includes(b.op)||typeof b.orderId!=='string'||!/^water_[a-zA-Z0-9_-]{1,100}$/.test(b.orderId)||b.companyId!==trusted.companyId)
  throw new https.HttpsError('permission-denied','Choose an authorized company and water order');
 if(Object.keys(b).some(k=>!['op','orderId','companyId',...(b.op==='save'?['value']:['dispatchId'])].includes(k)))invalid('Unexpected water order field');
 const db=admin.firestore(),ref=db.doc('projects/'+b.orderId);
 if(b.op==='save'){
  const v=b.value;
  if(!object(v)||Object.keys(v).some(k=>!['id','companyId','draft','plan','records','sent'].includes(k))||v.id!==b.orderId||v.companyId!==trusted.companyId||!object(v.draft)||!object(v.plan)||!object(v.records)||!Array.isArray(v.sent)||v.sent.length||Buffer.byteLength(JSON.stringify(v))>900000)invalid('Invalid or oversized water order');
  if(typeof v.draft.name!=='string'||!v.draft.name.trim()||v.draft.name.length>250||typeof v.draft.destination!=='string'||!v.draft.destination.trim()||v.draft.destination.length>500||typeof v.draft.notes!=='string'||v.draft.notes.length>6000||!Array.isArray(v.draft.tanks)||!v.draft.tanks.length||v.draft.tanks.length>120||!Array.isArray(v.draft.truckKeys)||!v.draft.truckKeys.length||v.draft.truckKeys.length>200)invalid('Check order name, destination, tanks and drivers');
  const p=v.plan;
  if(p.version!==1||!Array.isArray(p.trips)||!p.trips.length||p.trips.length>300||!Array.isArray(p.sources)||p.sources.length>1000||!Number.isFinite(Date.parse(p.createdAt))||!Number.isFinite(Date.parse(p.deadline))||Date.parse(p.deadline)<=Date.now()||Date.parse(p.deadline)-Date.parse(p.createdAt)>31*86400000||['target','existing','needed','planned','shortfall'].some(k=>!Number.isFinite(p[k])||p[k]<0))invalid('Invalid water plan');
  const ids=new Set<string>(),drivers=new Set<string>();
  for(const t of p.trips){
   const r=v.records[t.id];
   if(!object(t)||typeof t.id!=='string'||!t.id.startsWith('wo_'+b.orderId+'_')||t.id.length>150||ids.has(t.id)||!object(r)||r.dispatchId!==t.id||r.projectId!==b.orderId||r.wellName!==t.wellName||r.bbls!==t.bbl||!Number.isFinite(t.bbl)||t.bbl<=0||t.bbl>1000||!v.draft.truckKeys.includes(t.driverKey)||r.disposal!==v.draft.destination.trim()||r.jobType!=='pw'||r.status!=='pending'||r.loadCount!==1||typeof r.driverId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(r.driverId))invalid('Trip and frozen dispatch must match');
   ids.add(t.id);drivers.add(r.driverId);
  }
  if(Object.keys(v.records).length!==ids.size)invalid('Unexpected dispatch records');
  for(const driverId of drivers){const profile=(await admin.database().ref('drivers/profiles/'+driverId).once('value')).val();if(!profile||profile.active===false||profile.companyId!==trusted.companyId)throw new https.HttpsError('permission-denied','Driver is not active in this company');}
  const result=await db.runTransaction(async tx=>{
   const snap=await tx.get(ref);
   if(snap.exists){const old=snap.data()!;if(old.companyId!==trusted.companyId||!old.waterOrder||canonical({...old.waterOrder,sent:[]})!==canonical({...v,sent:[]}))throw new https.HttpsError('already-exists','Saved order changed; reopen it');return old.waterOrder;}
   tx.create(ref,{name:'Water Order · '+v.draft.name.trim(),companyId:trusted.companyId,createdBy:request.auth!.uid,createdAt:new Date().toISOString(),startDate:p.createdAt.slice(0,10),projectedEndDate:p.deadline.slice(0,10),wellNames:[...new Set(p.trips.map((t:any)=>t.wellName))],operatorName:[...new Set(p.sources.map((s:any)=>s.operator))].join('; '),jobType:'pw',status:'active',driverSchedule:{},notes:v.draft.notes,waterOrder:v});
   return v;
  });return {order:result};
 }
 if(typeof b.dispatchId!=='string'||b.dispatchId.length>150||!b.dispatchId.startsWith('wo_'+b.orderId+'_'))invalid('Invalid dispatch acknowledgement');
 return db.runTransaction(async tx=>{
  const [saved,dispatch]=await Promise.all([tx.get(ref),tx.get(db.doc('dispatches/'+b.dispatchId))]);
  const value=saved.data(),job=dispatch.data(),order=value?.waterOrder,record=order?.records?.[b.dispatchId];
  if(value?.companyId!==trusted.companyId||order?.companyId!==trusted.companyId||!record||!job||job.companyId!==trusted.companyId||job.projectId!==b.orderId||job.driverId!==record.driverId||job.wellName!==record.wellName||Number(job.bbls)!==Number(record.bbls))throw new https.HttpsError('failed-precondition','Dispatch has not been confirmed for this water order');
  const sent=[...new Set([...(order.sent||[]),b.dispatchId])];
  tx.update(ref,{'waterOrder.sent':sent});return {order:{...order,sent}};
 });
});
