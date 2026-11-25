import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {buildSsoDeps} from '../sso/ssoCallables';
import {checkRateLimit} from '../security/rateLimit';
import {handleLegacyEvidence,EvidenceError,type EvidenceStore} from './jsaLegacyEvidence';
export const jsaLegacyEvidence=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
 if(!request.auth?.uid)throw new https.HttpsError('unauthenticated','authentication');
 // Firebase production verifies token expiry. Keep the same refusal explicit
 // at this sensitive archive boundary (the Auth emulator accepts expired JWTs).
 const expires=Number(request.auth.token.exp);
 if(!Number.isFinite(expires)||expires*1000<=Date.now())throw new https.HttpsError('unauthenticated','session_expired');
 if(!await checkRateLimit({bucket:'jsa_legacy_evidence',key:request.auth.uid,limit:60,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
 const db=admin.firestore(),sso=buildSsoDeps();
 const store:EvidenceStore={
  transaction:fn=>db.runTransaction(tx=>fn({get:async path=>{const s=await tx.get(db.doc(path));return s.exists?s.data()!:null;},create:(path,row)=>{tx.create(db.doc(path),row);}})),
  // Older immutable originals may carry only driverHash. Query both exact,
  // company-bound owner fields; merge by document ID, then take one stable page.
  // Never add a canonical field to an already-signed snapshot to make it visible.
  list:async(companyId,driverId,after)=>{
   const pages=await Promise.all(['driverId','driverHash'].map(async field=>{
    let q=db.collection('jsas').where('companyId','==',companyId).where(field,'==',driverId).orderBy(admin.firestore.FieldPath.documentId()).limit(50);
    if(after)q=q.startAfter(after);return (await q.get()).docs;
   }));
   const docs=[...new Map(pages.flat().map(doc=>[doc.id,doc])).values()]
    .sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))).slice(0,50);
   return docs.map(doc=>{
    const row=doc.data();
    if(row.id!==doc.id)throw new EvidenceError('failed-precondition','history_cursor_mismatch');
    return row;
   });
  },
 };
 try{return await handleLegacyEvidence(store,{uid:request.auth.uid,claims:request.auth.token},request.data,async p=>{const d=await sso.getDriver(p.driverId);return !!d?.active&&d.driverId===p.driverId&&d.companyId===p.companyId;},Date.now());}
 catch(e){if(e instanceof EvidenceError)throw new https.HttpsError(e.code,e.message);throw new https.HttpsError('internal','unavailable');}
});
