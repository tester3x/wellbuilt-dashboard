import * as admin from 'firebase-admin';
import {HttpsError,onCall} from 'firebase-functions/v2/https';
import {loadCanonicalDriverAuthority,productionCanonicalDriverReaders} from './canonicalDriverAuthority';
import {checkRateLimit} from './rateLimit';

const FIELDS={
 invoice:['companyId','driverId','driverHash','photos','canonicalJobId','packetId','status','dispatchId','haulGroupId'],
 ticket:['companyId','driverId','driverHash','invoiceDocId','ticketNumber','bbls','finishedTime'],
 dispatch:['companyId','driverId','driverHash','status','driverStage','driverDest','invoiceNumber','hauledTo','driverLat','driverLng','driverGpsAt','stageUpdatedAt','loadCount','loadsCompleted','invoiceDocId'],
} as const;
const COLLECTIONS={invoice:'invoices',ticket:'tickets',dispatch:'dispatches'} as const;
export function parseDeliverySnapshotRequest(raw:unknown){
 const x=raw as {version:unknown;kind:unknown;id:unknown};
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==3||x.version!==1
  ||!Object.prototype.hasOwnProperty.call(COLLECTIONS,String(x.kind))||typeof x.id!=='string'||!/^[A-Za-z0-9_.:\-]{1,300}$/.test(x.id))throw new HttpsError('invalid-argument','invalid_delivery_read');
 return {kind:x.kind as keyof typeof COLLECTIONS,id:x.id};
}
export function deliverySnapshotFields(kind:keyof typeof COLLECTIONS,row:Record<string,unknown>,owner:{driverId:string;companyId:string}){
 if(row.companyId!==owner.companyId||(row.driverId||row.driverHash)!==owner.driverId)throw new HttpsError('permission-denied','foreign_resource');
 return Object.fromEntries(FIELDS[kind].filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
}
/** Read-only replay metadata. Ownership and scope come solely from canonical auth. */
export const getDriverDeliverySnapshot=onCall({timeoutSeconds:20,enforceAppCheck:false},async request=>{
 const claims=request.auth?.token;
 if(!request.auth?.uid||claims?.kind!=='driver'||typeof claims.driverId!=='string')throw new HttpsError('unauthenticated','driver_required');
 const owner=await loadCanonicalDriverAuthority(claims.driverId,productionCanonicalDriverReaders());
 if(!owner?.active||owner.companyId!==claims.companyId||(claims.app!=null&&claims.app!=='wbt'))throw new HttpsError('permission-denied','driver_scope_changed');
 const {kind,id}=parseDeliverySnapshotRequest(request.data);
 if(!await checkRateLimit({bucket:'driver_delivery_snapshot',key:request.auth.uid,limit:600,windowMs:600000}))throw new HttpsError('resource-exhausted','retry_later');
 const snapshot=await admin.firestore().collection(COLLECTIONS[kind]).doc(id).get();
 return {version:1,kind,id,exists:snapshot.exists,data:snapshot.exists?deliverySnapshotFields(kind,snapshot.data()!,owner):null};
});
