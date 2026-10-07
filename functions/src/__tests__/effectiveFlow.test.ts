import {effectiveFlow} from '../effectiveFlow';
const p=(id:string,h:number,t:number,b:number)=>({packetId:id,dateTimeUTC:new Date(Date.UTC(2026,0,1)+h*3600000).toISOString(),tankTopInches:t,tankAfterInches:b,bblsTaken:170});
test('feature is opt-in and tiny recovery does not add another averaging sample',()=>{
 const h={a:p('a',0,100,66),b:p('b',24,78,44),c:p('c',25,44,10)};
 expect(effectiveFlow(h,{})).toBeNull();expect(effectiveFlow(h,{flowWindowMinimumRecoveryInches:6})?.averageDays).toBe(1);
});
test('delete and edit recompute the average from current observations',()=>{
 const cfg={flowWindowMinimumRecoveryInches:6};const h={a:p('a',0,100,66),b:p('b',24,78,44),c:p('c',36,56,22)};
 expect(effectiveFlow(h,cfg)?.averageDays).toBeCloseTo(.8);
 delete (h as any).b;expect(effectiveFlow(h,cfg)?.results[1].action).toBe('reset');
});
