import {advanceJsaWorkPeriod,OFF_SHIFT_JSA_WINDOW_MS,jsaShiftClosureReason,type JsaWorkPeriod} from '../jsaWorkPeriod';
const input={companyId:'c',driverId:'d',day:'2026-10-18',shift:{state:'none' as const},now:1,newId:'a'.repeat(48)};
const first=()=>advanceJsaWorkPeriod(null,input).current;
test('pre-shift context survives midnight without starting HOS',()=>{
 const old=first();expect(advanceJsaWorkPeriod(old,{...input,day:'2026-10-19',now:2,newId:'b'.repeat(48)}).current).toEqual(old);
});
test('clock-in finalizes off-shift context and starts a fresh period; same shift after midnight retains identity',()=>{
 const shift={state:'open' as const,periodId:'2026-10-18_220000',originLocalDate:input.day};
 const {current:attached,finalized}=advanceJsaWorkPeriod(first(),{...input,shift,newId:'b'.repeat(48)});
 expect(finalized).toMatchObject({id:'a'.repeat(48),state:'finalized',shiftId:null});
 expect(attached.id).toBe('b'.repeat(48));expect(attached.shiftId).toBe(shift.periodId);
 expect(advanceJsaWorkPeriod(attached,{...input,shift,day:'2026-10-19'}).current).toEqual(attached);
});
test('verified end or another shift finalizes only the old context and requires a fresh read',()=>{
 const old={...first(),shiftId:'2026-10-18_220000'};
 const next=advanceJsaWorkPeriod(old,{...input,now:99,newId:'b'.repeat(48)});
 expect(next.finalized).toMatchObject({id:'a'.repeat(48),state:'finalized',finalizedAtMs:99});
 expect(next.current.id).toBe('b'.repeat(48));expect(next.current.shiftId).toBeNull();
});
test('unavailable authority never finalizes or steals another owner context',()=>{
 const old={...first(),shiftId:'2026-10-18_220000'};
 expect(advanceJsaWorkPeriod(old,{...input,shift:{state:'unverifiable',reason:'authority_absent'}}).current).toEqual(old);
 expect(()=>advanceJsaWorkPeriod({...old,driverId:'foreign'} as JsaWorkPeriod,input)).toThrow('owner');
});

test.each([0,45*60*1000,12*60*60*1000,OFF_SHIFT_JSA_WINDOW_MS-1])('off-shift period remains the same at elapsed %i ms',elapsed=>{
 const old=first();const out=advanceJsaWorkPeriod(old,{...input,day:'2026-10-19',now:old.createdAtMs+elapsed,newId:'b'.repeat(48)});
 expect(out.current).toEqual(old);expect(out.finalized).toBeNull();
});
test.each([OFF_SHIFT_JSA_WINDOW_MS,OFF_SHIFT_JSA_WINDOW_MS+1,24*60*60*1000])('next off-shift job replaces the expired period at %i ms',elapsed=>{
 const old=first();const now=old.createdAtMs+elapsed;
 const out=advanceJsaWorkPeriod(old,{...input,now,newId:'b'.repeat(48)});
 expect(out.finalized).toMatchObject({id:old.id,state:'finalized',finalizedAtMs:now,finalizationReason:'off_shift_window_expired'});
 expect(out.current).toMatchObject({id:'b'.repeat(48),shiftId:null,createdAtMs:now});
 expect(old.state).toBe('open');
});
test('seven hours working and seven stopped does not renew the anchored window',()=>{
 const old=first();const mid=advanceJsaWorkPeriod(old,{...input,now:old.createdAtMs+7*60*60*1000}).current;
 expect(mid.createdAtMs).toBe(old.createdAtMs);
 expect(advanceJsaWorkPeriod(mid,{...input,now:old.createdAtMs+OFF_SHIFT_JSA_WINDOW_MS,newId:'b'.repeat(48)}).current.id).not.toBe(old.id);
});
test('active-job coverage reads do not expire its JSA while work is in progress',()=>{
 const old=first();const out=advanceJsaWorkPeriod(old,{...input,now:old.createdAtMs+OFF_SHIFT_JSA_WINDOW_MS,rolloverExpiredOffShift:false});
 expect(out.current).toEqual(old);expect(out.finalized).toBeNull();
});
test('clock-in and clock-out cannot revive the earlier off-shift period within fourteen hours',()=>{
 const off=first(),shift={state:'open' as const,periodId:'2026-10-18_220000',originLocalDate:input.day};
 const on=advanceJsaWorkPeriod(off,{...input,now:2,shift,newId:'b'.repeat(48)});
 expect(on.finalized?.finalizationReason).toBe('shift_started');
 const next=advanceJsaWorkPeriod(on.current,{...input,now:3,newId:'c'.repeat(48)});
 expect(next.current.id).toBe('c'.repeat(48));expect(next.current.id).not.toBe(off.id);
 expect(jsaShiftClosureReason(on.current,shift)).toBeNull();
});
test('unknown shift authority cannot expire an off-shift period',()=>{
 const old=first();expect(advanceJsaWorkPeriod(old,{...input,now:old.createdAtMs+24*60*60*1000,shift:{state:'unverifiable',reason:'authority_absent'}}).current).toEqual(old);
});
