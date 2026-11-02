import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {parseAuthPrincipal,requireAudience} from './jsaReceiptCore';
import {resolveSubject} from '../security/operational/shiftAuthorityCallables';
import {decideResolve,type ShiftAuthorityRecord} from '../security/operational/shiftAuthority';
import {shiftJsaSummaryStore} from './jsaShiftSummaryStore';
import {checkRateLimit} from '../security/rateLimit';
import {readShiftJsaPreview} from './jsaShiftPreview';
export const jsaGetShiftPreview=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
 const p=parseAuthPrincipal({uid:request.auth?.uid,claims:request.auth?.token});
 if(!p.ok||!requireAudience(p.value,'wbt').ok)throw new https.HttpsError('permission-denied','tickets_session_required');
 const owner=await resolveSubject(request);
 if(owner.companyId!==p.value.companyId||owner.driverId!==p.value.driverId)throw new https.HttpsError('permission-denied','owner_changed');
 if(!await checkRateLimit({bucket:'jsa_shift_preview',key:request.auth!.uid,limit:60,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
 const db=admin.firestore(),store=shiftJsaSummaryStore(db),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 const standalonePath=`jsa_standalone_companies/${hash(owner.companyId)}/drivers/${hash(owner.driverId)}/records`;
 const ownedQuery=(path:string)=>db.collection(path).where('companyId','==',owner.companyId).where('driverId','==',owner.driverId);
 const rows=(page:admin.firestore.QuerySnapshot)=>page.docs.map(d=>({...d.data(),id:d.id}));
 const resolveShift=async()=>decideResolve(((await db.doc('driver_shift_authority/'+owner.driverId).get()).data()||null) as ShiftAuthorityRecord|null,owner);
 const before=await resolveShift();
 try{const result=await readShiftJsaPreview({
  shift:async()=>before,
  list:async(c,shiftId,periodIds)=>{
   if(c!=='standalone')return store.list(c,owner.companyId,owner.driverId,{shiftId,periodIds});
   const filters:[string,string][]=[['shiftId',shiftId],...periodIds.map(id=>['jsaPeriodId',id] as [string,string])];
   const pages=await Promise.all(filters.map(([f,v])=>ownedQuery(standalonePath).where(f,'==',v).limit(2001).get()));
   return [...new Map(pages.flatMap(p=>rows(p).map(r=>[r.id,r] as const))).values()];
  },
  artifact:store.artifact,
  job:async id=>{const snap=await db.collection('invoices').doc(id).get();return snap.exists?snap.data()!:null;},
  companyName:async()=>{const snap=await db.collection('companies').doc(owner.companyId).get();const c=snap.data();return String(c?.name||c?.companyName||c?.displayName||'');},
  history:async()=>{const [requests,standalone]=await Promise.all([ownedQuery('jsa_governed_requests').limit(2001).get(),ownedQuery(standalonePath).limit(2001).get()]);return {requests:rows(requests),standalone:rows(standalone)};},
  linkedStops:async id=>{const pages=await Promise.all(['jsa_job_acknowledgments','jsa_job_read_coverage'].map(c=>ownedQuery(c).where('fullReadId','==',id).limit(2001).get()));return pages.flatMap(rows);},
 },owner,request.data);
 const after=await resolveShift();
 if(after.state!==before.state||(after.state==='open'&&before.state==='open'&&after.periodId!==before.periodId))throw Error('shift_changed');
 return result;}catch(e){throw new https.HttpsError(e instanceof Error&&e.message==='invalid_input'?'invalid-argument':'failed-precondition','saved_shift_jsa_unavailable');}
});
