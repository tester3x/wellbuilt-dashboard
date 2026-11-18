import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {checkRateLimit} from '../security/rateLimit';
import {jsaDisplayCorrectionOperation} from './jsaDisplayCorrections';
export const jsaDisplayCorrections=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
 if(!request.auth?.uid)throw new https.HttpsError('unauthenticated','Sign in first.');
 if(!await checkRateLimit({bucket:'jsa_display_corrections',key:request.auth.uid,limit:60,windowMs:600000}))throw new https.HttpsError('resource-exhausted','Retry later.');
 const db=admin.firestore(),collection=db.collection('jsa_display_corrections');
 try{return await jsaDisplayCorrectionOperation({list:async(company,driver)=>{const rows=await collection.where('companyId','==',company).where('driverId','==',driver).limit(501).get();return rows.docs.map(d=>d.data());},put:async e=>{const id=createHash('sha256').update(JSON.stringify([e.companyId,e.driverId,e.recordId,e.sourceFingerprint,e.actorUid,e.confirmedAtMs])).digest('hex');await db.runTransaction(async tx=>{const ref=collection.doc(id),prior=await tx.get(ref);if(prior.exists){const a={...prior.data()},b={...e};delete a.receivedAtMs;delete b.receivedAtMs;if(JSON.stringify(Object.keys(a).sort().map(k=>[k,a[k]]))!==JSON.stringify(Object.keys(b).sort().map(k=>[k,b[k]])))throw Error('conflicting_confirmation');return;}tx.create(ref,e);});}}, {uid:request.auth.uid,claims:request.auth.token},request.data);}
 catch(e){const reason=e instanceof Error?e.message:'';throw new https.HttpsError(reason==='not_authorized'?'permission-denied':reason==='invalid_input'?'invalid-argument':'failed-precondition','Supplemental JSA information could not be saved or read.');}
});
