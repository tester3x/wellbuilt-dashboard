import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {resolveSubject} from '../security/operational/shiftAuthorityCallables';
import {checkRateLimit} from '../security/rateLimit';
import {parseShiftSummaryInput,readShiftJsaSummary} from './jsaShiftSummary';
import {shiftJsaSummaryStore} from './jsaShiftSummaryStore';

export const jsaShiftSummary=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
  const subject=await resolveSubject(request);
  let requested:string|null;
  try{requested=parseShiftSummaryInput(request.data);}catch{throw new https.HttpsError('invalid-argument','invalid_input');}
  if(!await checkRateLimit({bucket:'jsa_shift_summary',key:request.auth!.uid,limit:60,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
  const db=admin.firestore();
  // No date fallback after close. This is a read, not resolveJsaWorkPeriod.
  if(!requested){
    const a=(await db.doc('driver_shift_authority/'+subject.driverId).get()).data();
    if(a?.driverId!==subject.driverId||a?.companyId!==subject.companyId||a?.initialized!==true)throw new https.HttpsError('failed-precondition','shift_unverified');
    requested=a.openPeriodId||a.lastClosedPeriodId||null;
    if(requested&&!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(requested))throw new https.HttpsError('failed-precondition','shift_unverified');
  }
  try{return await readShiftJsaSummary(shiftJsaSummaryStore(db),subject,requested);}
  catch{throw new https.HttpsError('failed-precondition','jsa_summary_unavailable');}
});
