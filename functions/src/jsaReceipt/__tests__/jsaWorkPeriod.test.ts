import {advanceJsaWorkPeriod,type JsaWorkPeriod} from '../jsaWorkPeriod';
const input={companyId:'c',driverId:'d',day:'2026-10-18',shift:{state:'none' as const},now:1,newId:'a'.repeat(48)};
const first=()=>advanceJsaWorkPeriod(null,input).current;
test('pre-shift context survives midnight without starting HOS',()=>{
 const old=first();expect(advanceJsaWorkPeriod(old,{...input,day:'2026-10-19',now:2,newId:'b'.repeat(48)}).current).toEqual(old);
});
test('clock-in attaches the same signed context; same shift after midnight retains identity',()=>{
 const shift={state:'open' as const,periodId:'2026-10-18_220000',originLocalDate:input.day};
 const attached=advanceJsaWorkPeriod(first(),{...input,shift}).current;
 expect(attached.id).toBe('a'.repeat(48));expect(attached.shiftId).toBe(shift.periodId);
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
