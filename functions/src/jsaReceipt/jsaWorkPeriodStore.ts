import * as admin from 'firebase-admin';
import {createHash,randomBytes} from 'crypto';
import {decideResolve,shiftAuthorityPath,type ShiftAuthorityRecord} from '../security/operational/shiftAuthority';
import {advanceJsaWorkPeriod,type JsaWorkPeriod} from './jsaWorkPeriod';

export async function resolveJsaWorkPeriod(companyId:string,driverId:string,day:string):Promise<JsaWorkPeriod>{
 const db=admin.firestore(),key=createHash('sha256').update(JSON.stringify([companyId,driverId])).digest('hex');
 const ref=db.doc('jsa_active_work_periods/'+key),newId=randomBytes(24).toString('hex');
 return db.runTransaction(async tx=>{
  const authority=await tx.get(db.doc(shiftAuthorityPath(driverId)));
  const shift=decideResolve((authority.data()||null) as ShiftAuthorityRecord|null,{driverId,companyId});
  const old=(await tx.get(ref)).data() as JsaWorkPeriod|undefined;
  const {current,finalized}=advanceJsaWorkPeriod(old||null,{companyId,driverId,day,shift,now:Date.now(),newId});
  if(finalized)tx.set(db.doc('jsa_work_periods/'+finalized.id),finalized);
  if(!old||old.id!==current.id||old.state!==current.state||old.shiftId!==current.shiftId){tx.set(ref,current);tx.set(db.doc('jsa_work_periods/'+current.id),current);}
  return current;
 });
}

/** Preserve immutable signed content; closure is lifecycle metadata. */
export function withJsaPeriodFinalization(record:Record<string,unknown>,period:Record<string,unknown>|undefined){
 if(record.state==='closed')return record;
 if(!period||period.id!==record.jsaPeriodId||period.companyId!==record.companyId||period.driverId!==record.driverId||period.state!=='finalized'||!Number.isFinite(period.finalizedAtMs))return record;
 return {...record,state:'closed',closedAtMs:period.finalizedAtMs,finalizationReason:'shift_ended'};
}
