import type {ResolveResult} from '../security/operational/shiftAuthority';

/** JSA lifecycle is separate from HOS. A pre-shift read attaches to the next
 * verified shift without changing its JSA identity or crossing-midnight scope. */
export type JsaWorkPeriod = {
  id:string; companyId:string; driverId:string; originDate:string;
  shiftId:string|null; state:'open'|'finalized'; createdAtMs:number;
  finalizedAtMs?:number; finalizationReason?:string;
};
export function advanceJsaWorkPeriod(old:JsaWorkPeriod|null, input:{companyId:string;driverId:string;day:string;shift:ResolveResult;now:number;newId:string}) {
  if(old&&(old.companyId!==input.companyId||old.driverId!==input.driverId))throw Error('JSA period owner mismatch');
  if(old&&(!/^[a-f0-9]{48}$/.test(old.id)||!/^\d{4}-\d{2}-\d{2}$/.test(old.originDate)||!Number.isFinite(old.createdAtMs)||!['open','finalized'].includes(old.state)))throw Error('Malformed JSA period');
  const shiftId=input.shift.state==='open'?input.shift.periodId:null;
  const ended=!!old?.shiftId&&input.shift.state!=='unverifiable'&&old.shiftId!==shiftId;
  const finalized=old?.state==='open'&&ended?{...old,state:'finalized' as const,finalizedAtMs:input.now,finalizationReason:'shift_ended'}:null;
  // An unknown shift status never closes a JSA or starts another read period.
  const current=old?.state==='open'&&!ended
    ? {...old,shiftId:old.shiftId||shiftId}
    : {id:input.newId,companyId:input.companyId,driverId:input.driverId,originDate:input.day,shiftId,state:'open' as const,createdAtMs:input.now};
  return {current,finalized};
}
