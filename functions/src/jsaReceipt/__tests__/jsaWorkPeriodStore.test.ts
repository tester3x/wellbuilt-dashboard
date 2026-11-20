import {createHash} from 'crypto';
import * as admin from 'firebase-admin';
import {resolveJsaWorkPeriod,withJsaPeriodFinalization} from '../jsaWorkPeriodStore';
import {OFF_SHIFT_JSA_WINDOW_MS} from '../jsaWorkPeriod';

jest.mock('firebase-admin',()=>({firestore:jest.fn()}));
const owner={companyId:'company-test',driverId:'driver-test'};
const key=createHash('sha256').update(JSON.stringify([owner.companyId,owner.driverId])).digest('hex');
const active='jsa_active_work_periods/'+key;
const old={...owner,id:'a'.repeat(48),originDate:'2026-11-19',shiftId:null,state:'open',createdAtMs:1000};
let docs:Map<string,any>,writes:string[];
beforeEach(()=>{
 docs=new Map([[active,{...old}],['driver_shift_authority/'+owner.driverId,{...owner,initialized:true,openPeriodId:null,originLocalDate:null,version:1}],['jsa_governed_artifacts/signed',{snapshot:{signature:'unchanged'}}]]);writes=[];
 (admin.firestore as unknown as jest.Mock).mockReturnValue({doc:(path:string)=>({path}),runTransaction:async(fn:any)=>fn({get:async(ref:any)=>({data:()=>docs.get(ref.path)}),set:(ref:any,value:any)=>{writes.push(ref.path);docs.set(ref.path,value);}})});
 jest.spyOn(Date,'now').mockReturnValue(old.createdAtMs+OFF_SHIFT_JSA_WINDOW_MS);
});
afterEach(()=>jest.restoreAllMocks());
test('next job atomically closes the expired period and retries reuse one new period',async()=>{
 const signature=JSON.stringify(docs.get('jsa_governed_artifacts/signed'));
 const first=await resolveJsaWorkPeriod(owner.companyId,owner.driverId,'2026-11-20');
 const retry=await resolveJsaWorkPeriod(owner.companyId,owner.driverId,'2026-11-20');
 expect(retry.id).toBe(first.id);expect(first.id).not.toBe(old.id);
 expect(docs.get('jsa_work_periods/'+old.id)).toMatchObject({state:'finalized',finalizationReason:'off_shift_window_expired',finalizedAtMs:Date.now()});
 expect(writes).toHaveLength(3);
 expect(writes.every(path=>path.startsWith('jsa_work_periods/')||path.startsWith('jsa_active_work_periods/'))).toBe(true);
 expect(JSON.stringify(docs.get('jsa_governed_artifacts/signed'))).toBe(signature);
});
test('coverage lookup after fourteen hours performs no lifecycle writes',async()=>{
 const current=await resolveJsaWorkPeriod(owner.companyId,owner.driverId,'2026-11-20',{rolloverExpiredOffShift:false});
 expect(current.id).toBe(old.id);expect(writes).toEqual([]);
});
test.each(['shift_started','off_shift_window_expired'])('closed report projects %s without modifying its signed content',reason=>{
 const record={...owner,jsaPeriodId:old.id,state:'open',snapshot:{signature:'original'}};
 const projected=withJsaPeriodFinalization(record,{...old,state:'finalized',finalizedAtMs:Date.now(),finalizationReason:reason});
 expect(projected.finalizationReason).toBe(reason);expect(projected.snapshot).toBe(record.snapshot);expect(record.state).toBe('open');
});
