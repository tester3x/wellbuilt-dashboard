import {calculateFlowWindows} from '../flowWindows';
const p=(id:string,h:number,top:number,bottom:number)=>({packetId:id,dateTimeUTC:new Date(Date.UTC(2026,0,1)+h*3600000).toISOString(),tankTopInches:top,tankAfterInches:bottom,bblsTaken:170});
test('held loads are not extra AFR samples and later interval includes their measured drops',()=>{const r=calculateFlowWindows({a:p('a',0,100,66),b:p('b',24,78,44),c:p('c',25,44,10),d:p('d',36,16,0)},6);expect(r.map(x=>x.flowRateDays)).toEqual([0,1,0,1]);expect(r[3].recoveryInches).toBe(6);});
test('editing a held measurement changes subsequent recovery when replayed',()=>{const h={a:p('a',0,100,66),b:p('b',24,78,44),c:p('c',25,44,10),d:p('d',36,16,0)};h.c.tankAfterInches=9;expect(calculateFlowWindows(h,6)[3].recoveryInches).toBe(7);});
test('deleted observation is omitted; missing/down interval is not bridged',()=>{const h={a:p('a',0,100,66),b:{...p('b',1,66,32),wellDown:true},c:p('c',24,78,44)};expect(calculateFlowWindows(h,6)[2].action).toBe('anchor');});
test('configuration is bounded and negative recovery resets',()=>{expect(()=>calculateFlowWindows({},0)).toThrow();expect(calculateFlowWindows({a:p('a',0,100,66),b:p('b',1,50,16)},6)[1].action).toBe('reset');});
test('the same packet under an idempotency alias is one observation',()=>{const a=p('a',0,100,66);expect(calculateFlowWindows({a,idem_a:a,b:p('b',24,78,44)},6)).toHaveLength(2);});

test('provisional barrel guesses break flow windows instead of training or bridging them',()=>{
 const history={a:{dateTimeUTC:'2026-10-07T10:00:00Z',tankTopInches:144,tankAfterInches:120,bblsTaken:120},b:{source:'whatsapp_watchdog',dateTimeUTC:'2026-10-07T11:00:00Z',tankTopInches:132,tankAfterInches:108,bblsTaken:130,watchdogProvenance:{principalId:'laptop-watchdog-v2',barrels:{status:'provisional'}}},c:{dateTimeUTC:'2026-10-07T12:00:00Z',tankTopInches:120,tankAfterInches:96,bblsTaken:120}};
 const rows=calculateFlowWindows(history,6);expect(rows[1].action).toBe('break');expect(rows[1].flowRateDays).toBe(0);expect(rows[2].action).toBe('anchor');
});
