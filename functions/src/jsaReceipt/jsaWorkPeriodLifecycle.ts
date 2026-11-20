import {onDocumentWritten} from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {decideResolve,shiftAuthorityPath,type ShiftAuthorityRecord} from '../security/operational/shiftAuthority';
import {jsaShiftClosureReason,type JsaWorkPeriod} from './jsaWorkPeriod';

/** Re-read authority inside the transaction: delayed/replayed events cannot
 * finalize a newer shift. This changes JSA metadata only, never HOS. */
export const jsaFinalizeShiftContext=onDocumentWritten('driver_shift_authority/{driverId}',async event=>{
  const data=event.data?.after.data();
  if(!data?.companyId||data.driverId!==event.params.driverId)return;
  const companyId=String(data.companyId),driverId=event.params.driverId,db=admin.firestore();
  const key=createHash('sha256').update(JSON.stringify([companyId,driverId])).digest('hex');
  const active=db.doc('jsa_active_work_periods/'+key);
  await db.runTransaction(async tx=>{
    const authority=await tx.get(db.doc(shiftAuthorityPath(driverId)));
    const state=decideResolve((authority.data()||null) as ShiftAuthorityRecord|null,{driverId,companyId});
    const old=(await tx.get(active)).data() as JsaWorkPeriod|undefined;
    if(!old||old.companyId!==companyId||old.driverId!==driverId||old.state!=='open'||state.state==='unverifiable')return;
    const reason=jsaShiftClosureReason(old,state);
    if(!reason)return;
    const finalized={...old,state:'finalized',finalizedAtMs:Date.now(),finalizationReason:reason};
    tx.set(active,finalized);tx.set(db.doc('jsa_work_periods/'+old.id),finalized);
  });
});
