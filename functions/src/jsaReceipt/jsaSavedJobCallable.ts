import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {checkRateLimit} from '../security/rateLimit';
import {readSavedJobJsa} from './jsaSavedJob';

export const jsaGetSavedJob = https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
  if(!request.auth?.uid)throw new https.HttpsError('unauthenticated','Sign in through Suite.');
  if(!await checkRateLimit({bucket:'jsa_saved_job',key:request.auth.uid,limit:30,windowMs:600000}))throw new https.HttpsError('resource-exhausted','Retry later.');
  const db=admin.firestore();
  try{return await readSavedJobJsa({
    async invoice(id){const d=await db.collection('invoices').doc(id).get();return d.exists?d.data()!:null;},
    async artifact(id){const d=await db.collection('jsa_governed_artifacts').doc(id).get();return d.exists?d.data()!:null;},
    async request(id){
      if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw Error('scope_or_size');
      const d=await db.collection('jsa_governed_requests').doc(id).get();return d.exists?d.data()!:null;
    },
    async list(collection,company,driver,jobRef){
      const rows:Record<string,unknown>[]=[];let cursor:admin.firestore.QueryDocumentSnapshot|undefined;
      do{let q=db.collection(collection).where('companyId','==',company).where('driverId','==',driver).orderBy(admin.firestore.FieldPath.documentId()).limit(100);
        if(jobRef)q=q.where('jobRef','==',jobRef);
        if(cursor)q=q.startAfter(cursor);const page=await q.get();rows.push(...page.docs.map(d=>({...d.data(),id:d.id})));if(rows.length>2000)throw Error('scope_or_size');cursor=page.size===100?page.docs[page.size-1]:undefined;
      }while(cursor);return rows;
    },
  },{uid:request.auth.uid,claims:request.auth.token},request.data);}
  catch(error){const reason=error instanceof Error?error.message:'';throw new https.HttpsError(reason==='not_authorized'?'permission-denied':reason==='invalid_job'?'invalid-argument':'failed-precondition','Saved JSA could not be loaded.');}
});
