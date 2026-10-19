import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {resolveSubject} from '../security/operational/shiftAuthorityCallables';
import {decideResolve,type ShiftAuthorityRecord} from '../security/operational/shiftAuthority';
import {parseAuthPrincipal,requireAudience} from './jsaReceiptCore';
import {shiftJsaSummaryStore} from './jsaShiftSummaryStore';
import {readJsaHomeState} from './jsaHomeState';
import {checkRateLimit} from '../security/rateLimit';
export const jsaHomeState=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
 const p=parseAuthPrincipal({uid:request.auth?.uid,claims:request.auth?.token});
 if(!p.ok||!requireAudience(p.value,'jsa').ok)throw new https.HttpsError('permission-denied','jsa_session_required');
 const owner=await resolveSubject(request);
 if(owner.companyId!==p.value.companyId)throw new https.HttpsError('permission-denied','company_changed');
 if(!await checkRateLimit({bucket:'jsa_home_state',key:request.auth!.uid,limit:90,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
 const db=admin.firestore(),store=shiftJsaSummaryStore(db),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 try{return await readJsaHomeState({
  shift:async()=>decideResolve(((await db.doc('driver_shift_authority/'+owner.driverId).get()).data()||null) as ShiftAuthorityRecord|null,owner),
  list:async(collection,shiftId,periodIds)=>{
   if(collection!=='standalone')return store.list(collection,owner.companyId,owner.driverId,{shiftId,periodIds});
   const path=`jsa_standalone_companies/${hash(owner.companyId)}/drivers/${hash(owner.driverId)}/records`;
   const filters:[string,string][]=[['shiftId',shiftId],...periodIds.map(id=>['jsaPeriodId',id] as [string,string])];
   const pages=await Promise.all(filters.map(([f,v])=>db.collection(path).where('companyId','==',owner.companyId).where('driverId','==',owner.driverId).where(f,'==',v).limit(2001).get()));
   return [...new Map(pages.flatMap(p=>p.docs.map(d=>[d.id,{...d.data(),id:d.id}] as const))).values()];
  },artifact:store.artifact,
  job:async id=>{const snap=await db.collection('invoices').doc(id).get();return snap.exists?snap.data()!:null;},
  companyName:async()=>{const snap=await db.collection('companies').doc(owner.companyId).get();const c=snap.data();return String(c?.name||c?.companyName||c?.displayName||'');},
 },owner,request.data);}catch(e){throw new https.HttpsError(e instanceof Error&&e.message==='invalid_input'?'invalid-argument':'failed-precondition','jsa_home_unavailable');}
});
