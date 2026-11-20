import type {ResolveResult} from '../security/operational/shiftAuthority';

/** JSA lifecycle is separate from HOS. An off-shift read stays in its own
 * period when the driver clocks in. */
export type JsaWorkPeriod = {
  id:string; companyId:string; driverId:string; originDate:string;
  shiftId:string|null; state:'open'|'finalized'; createdAtMs:number;
  finalizedAtMs?:number; finalizationReason?:string;
};
export const OFF_SHIFT_JSA_WINDOW_MS=14*60*60*1000;
export function offShiftJsaExpired(period:Pick<JsaWorkPeriod,'shiftId'|'createdAtMs'>,now:number){
  return period.shiftId===null && Number.isFinite(period.createdAtMs) && Number.isFinite(now)
    && now-period.createdAtMs>=OFF_SHIFT_JSA_WINDOW_MS;
}
export function jsaShiftClosureReason(old:JsaWorkPeriod,shift:ResolveResult){
  if(shift.state==='unverifiable')return null;
  const shiftId=shift.state==='open'?shift.periodId:null;
  if(old.shiftId===shiftId)return null;
  return shiftId ? old.shiftId ? 'shift_replaced' : 'shift_started' : 'shift_ended';
}
export function advanceJsaWorkPeriod(old:JsaWorkPeriod|null, input:{companyId:string;driverId:string;day:string;shift:ResolveResult;now:number;newId:string;rolloverExpiredOffShift?:boolean}) {
  if(old&&(old.companyId!==input.companyId||old.driverId!==input.driverId))throw Error('JSA period owner mismatch');
  if(old&&(!/^[a-f0-9]{48}$/.test(old.id)||!/^\d{4}-\d{2}-\d{2}$/.test(old.originDate)||!Number.isFinite(old.createdAtMs)||!['open','finalized'].includes(old.state)))throw Error('Malformed JSA period');
  const shiftId=input.shift.state==='open'?input.shift.periodId:null;
  const reason=old?jsaShiftClosureReason(old,input.shift):null;
  const expired=!!old && input.shift.state==='none' && input.rolloverExpiredOffShift!==false && offShiftJsaExpired(old,input.now);
  const ended=!!reason||expired;
  const finalized=old?.state==='open'&&ended?{...old,state:'finalized' as const,finalizedAtMs:input.now,finalizationReason:reason||'off_shift_window_expired'}:null;
  // An unknown shift status never closes a JSA or starts another read period.
  const current=old?.state==='open'&&!ended
    ? old
    : {id:input.newId,companyId:input.companyId,driverId:input.driverId,originDate:input.day,shiftId,state:'open' as const,createdAtMs:input.now};
  return {current,finalized};
}
