import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { buildSsoDeps } from '../sso/ssoCallables';
import { checkRateLimit } from '../security/rateLimit';
import { handleStandalone, StandaloneError, type StandaloneStore } from './jsaStandalone';
export const jsaStandalone=https.onCall({timeoutSeconds:30,memory:'512MiB',enforceAppCheck:false},async request=>{
 if(!request.auth?.uid)throw new https.HttpsError('unauthenticated','authentication');
 if(!await checkRateLimit({bucket:'jsa_standalone',key:request.auth.uid,limit:60,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
 const db=admin.firestore();
 const store:StandaloneStore={
  async readTemplate(path){const doc=await db.doc(path).get();return doc.exists?doc.data()!:null;},
  async list(path,after){let q=db.collection(path).orderBy(admin.firestore.FieldPath.documentId()).limit(50);if(after)q=q.startAfter(after);return(await q.get()).docs.map(d=>d.data());},
  async transaction(path,update){return db.runTransaction(async tx=>{const ref=db.doc(path),doc=await tx.get(ref),old=doc.exists?doc.data()!:null,next=update(old);if(next)tx.set(ref,next);return next||old!;});},
 };
 try{return await handleStandalone(buildSsoDeps(),store,{uid:request.auth.uid,claims:request.auth.token},request.data,Date.now());}
 catch(e){if(e instanceof StandaloneError)throw new https.HttpsError(e.code,e.message);throw new https.HttpsError('internal','unavailable');}
});
