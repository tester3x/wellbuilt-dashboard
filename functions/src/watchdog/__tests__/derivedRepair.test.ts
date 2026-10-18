import {planWatchdogDerivedRepair} from '../derivedRepair';
const base={requestType:'pull',wellName:'Synthetic',bblsTaken:165,tankLevelFeet:11.5,tankTopInches:138,dateTimeUTC:'2026-10-18T13:00:00Z',packetId:'a',tankAfterInches:88.5};
const provisional={...base,source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',reportedBottomFeet:9,barrels:{status:'provisional'},barrelSource:'estimated'}};
test('repair retains exact identity, observations and volumes; corrects only derivations and is idempotent',()=>{
 const history={a:provisional,b:{...base,packetId:'b',dateTimeUTC:'2026-10-18T14:00:00Z',tankTopInches:144}};
 const plan=planWatchdogDerivedRepair(history);expect(plan.corrected.a).toMatchObject({...provisional,tankAfterInches:108,flowRateDays:0});
 expect(plan.corrected.b.flowRateDays).toBe(0);expect(Object.keys(plan.corrected)).toEqual(Object.keys(history));expect(history.a.tankAfterInches).toBe(88.5);
 expect(planWatchdogDerivedRepair(plan.corrected).patches).toEqual({});
});
test('a missing measurement and estimated barrels cannot become an eligible rate; actual later intervals recover',()=>{
 const rows={a:provisional,b:{...base,packetId:'b',dateTimeUTC:'2026-10-18T14:00:00Z',tankAfterInches:120},c:{...base,packetId:'c',dateTimeUTC:'2026-10-18T15:00:00Z',tankTopInches:144,tankAfterInches:120,flowRateDays:1/48}};
 const plan=planWatchdogDerivedRepair(rows);expect(plan.corrected.a.flowRateDays).toBe(0);expect(plan.corrected.b.flowRateDays).toBe(0);expect(plan.eligibleSamples).toBe(1);expect(plan.averageDays).toBeCloseTo(1/48);
});
test('manual edited bottom and confirmed actual barrels are retained',()=>{
 const p={...provisional,wasEdited:true,tankAfterInches:100,watchdogProvenance:{...provisional.watchdogProvenance,barrels:{status:'confirmed'}}};expect(planWatchdogDerivedRepair({a:p}).corrected.a.tankAfterInches).toBe(100);
});
