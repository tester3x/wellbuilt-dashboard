import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {authorizeAdminCall} from '../admin/authority';
import {requireTrustedCompanyCapability} from './trustedStaffAuthority';
import {projectDispatchAccountSignal} from './dispatchDriverSignalsCore';

export const staffGetDispatchDriverSignals=https.onCall({region:'us-central1',timeoutSeconds:30},async request=>{
 if(!request.auth)throw new https.HttpsError('unauthenticated','Sign in required');
 const b=request.data;
 if(!b||Object.keys(b).some(k=>!['companyId','driverIds'].includes(k))||typeof b.companyId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(b.companyId)||!Array.isArray(b.driverIds)||b.driverIds.length>200||b.driverIds.some((id:any)=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(id)))throw new https.HttpsError('invalid-argument','Select a company and canonical drivers');
 const record=await admin.firestore().doc('platform_admins/'+request.auth.uid).get();
 if(!authorizeAdminCall(request.auth,record.data()).ok){const scope=await requireTrustedCompanyCapability(request.auth.uid,'viewDispatch');if(scope.companyId!==b.companyId)throw new https.HttpsError('permission-denied','Company scope mismatch');}
 const now=Date.now(),ids=[...new Set<string>(b.driverIds)],signals:Record<string,unknown>={};
 // Bounded batches, never read another company's proof or return profile/auth data.
 for(let offset=0;offset<ids.length;offset+=20){await Promise.all(ids.slice(offset,offset+20).map(async id=>{
  const db=admin.database(),profile=(await db.ref('drivers/profiles/'+id).once('value')).val();
  if(!profile||profile.companyId!==b.companyId){signals[id]={state:'unknown',verifiedAt:null,signedOutAt:null};return;}
  const proof=(await db.ref('drivers/identityProofs/'+id).once('value')).val();
  signals[id]=projectDispatchAccountSignal(id,proof,profile,now);
 }));}
 return {companyId:b.companyId,asOf:now,signals};
});
