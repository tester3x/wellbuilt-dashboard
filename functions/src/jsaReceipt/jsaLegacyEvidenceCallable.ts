import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {buildSsoDeps} from '../sso/ssoCallables';
import {checkRateLimit} from '../security/rateLimit';
import {handleLegacyEvidence,EvidenceError,type EvidenceStore} from './jsaLegacyEvidence';
export const jsaLegacyEvidence=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
 if(!request.auth?.uid)throw new https.HttpsError('unauthenticated','authentication');
 if(!await checkRateLimit({bucket:'jsa_legacy_evidence',key:request.auth.uid,limit:60,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
 const db=admin.firestore(),sso=buildSsoDeps();
 const store:EvidenceStore={
  transaction:fn=>db.runTransaction(tx=>fn({get:async path=>{const s=await tx.get(db.doc(path));return s.exists?s.data()!:null;},create:(path,row)=>{tx.create(db.doc(path),row);}})),
  list:async(companyId,driverId,after)=>{let q=db.collection('jsas').where('companyId','==',companyId).where('driverId','==',driverId).orderBy(admin.firestore.FieldPath.documentId()).limit(50);if(after)q=q.startAfter(after);return (await q.get()).docs.map(d=>d.data());},
 };
 try{return await handleLegacyEvidence(store,{uid:request.auth.uid,claims:request.auth.token},request.data,async p=>{const d=await sso.getDriver(p.driverId);return !!d?.active&&d.driverId===p.driverId&&d.companyId===p.companyId;},Date.now());}
 catch(e){if(e instanceof EvidenceError)throw new https.HttpsError(e.code,e.message);throw new https.HttpsError('internal','unavailable');}
});
