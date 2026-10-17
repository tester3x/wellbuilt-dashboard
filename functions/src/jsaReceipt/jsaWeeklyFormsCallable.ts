import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { checkRateLimit } from '../security/rateLimit';
import { readWeeklyJsaForms } from './jsaWeeklyForms';

export const jsaWeeklyForms = https.onCall({timeoutSeconds:60,memory:'512MiB',enforceAppCheck:false},async request=>{
  if(!request.auth?.uid)throw new https.HttpsError('unauthenticated','Sign in to JSA.');
  if(!await checkRateLimit({bucket:'jsa_weekly_forms',key:request.auth.uid,limit:30,windowMs:600000}))throw new https.HttpsError('resource-exhausted','Retry later.');
  const db=admin.firestore();
  try{return await readWeeklyJsaForms({
    async list(collection,companyId,driverId){
      let cursor:admin.firestore.QueryDocumentSnapshot|undefined;const rows:Record<string,unknown>[]=[];
      do{
        let q=db.collection(collection).where('companyId','==',companyId).where('driverId','==',driverId).orderBy(admin.firestore.FieldPath.documentId()).limit(100);
        if(cursor)q=q.startAfter(cursor);
        const page=await q.get();rows.push(...page.docs.map(d=>({...d.data(),id:d.id})));
        if(rows.length>2000)throw new Error('too_large');
        cursor=page.size===100?page.docs[page.docs.length-1]:undefined;
      }while(cursor);
      return rows;
    },async artifact(id){const d=await db.collection('jsa_governed_artifacts').doc(id).get();return d.exists?d.data()!:null;},
  },{uid:request.auth.uid,claims:request.auth.token},request.data);}
  catch(error){const reason=error instanceof Error?error.message:'';throw new https.HttpsError(reason==='not_authorized'?'permission-denied':reason==='invalid_period'?'invalid-argument':'failed-precondition','Historical JSA forms are unavailable.');}
});
