import {preparedShiftRead} from '../jsaOfflineCore';
import {advanceJsaWorkPeriod} from '../jsaWorkPeriod';
const owner={companyId:'company',driverId:'driver'};
const old={...owner,id:'a'.repeat(48),originDate:'2026-11-22',shiftId:null,state:'open' as const,createdAtMs:100};
const shift={state:'open' as const,periodId:'2026-11-24_052211',originLocalDate:'2026-11-24'};
const read={...owner,requestId:'old-read',state:'completed',action:'read_and_acknowledged',completedAtMs:200,binding:{jsaPeriodId:old.id,associatedPeriodId:null}};
test('offline preparation starts a new shift period and cannot reuse the prior signed read',()=>{
 const {current,finalized}=advanceJsaWorkPeriod(old,{...owner,day:'2026-11-24',shift,now:300,newId:'b'.repeat(48)});
 expect(finalized).toMatchObject({id:old.id,state:'finalized',finalizationReason:'shift_started'});
 expect(current.id).not.toBe(old.id);expect(preparedShiftRead([read],current)).toBeNull();
 // The immutable read remains in its original off-shift period.
 expect(read.binding).toEqual({jsaPeriodId:old.id,associatedPeriodId:null});
});
test('even a legacy promoted period cannot make an old shift read qualify',()=>{
 expect(preparedShiftRead([read],{...old,shiftId:shift.periodId})).toBeNull();
});
test('same-shift reads survive midnight; another driver/period/shift cannot qualify',()=>{
 const context={...old,shiftId:shift.periodId};
 const fresh={...read,requestId:'fresh',completedAtMs:400,binding:{jsaPeriodId:old.id,associatedPeriodId:shift.periodId}};
 expect(preparedShiftRead([read,fresh],context)).toEqual(fresh);
 expect(preparedShiftRead([{...fresh,driverId:'other'}],context)).toBeNull();
 expect(preparedShiftRead([{...fresh,binding:{...fresh.binding,jsaPeriodId:'other'}}],context)).toBeNull();
 expect(preparedShiftRead([{...fresh,binding:{...fresh.binding,associatedPeriodId:'other'}}],context)).toBeNull();
});
