import {calculateInventoryProduction as rate} from '../inventoryProduction';
const start=Date.parse('2026-10-20T12:00:00Z');
const reading=(hour:number,bottom=6,bbl=185,extra:Record<string,any>={})=>({requestType:'pull',dateTimeUTC:new Date(start+hour*3600000).toISOString(),tankLevelFeet:bottom+1,bblsTaken:bbl,tankAfterInches:bottom*12,...extra});
const history=(...rows:any[])=>Object.fromEntries(rows.map((r,i)=>['p'+i,r]));
describe('completed-load inventory balance',()=>{
 test('steady levels include water entering during loading without estimating duration',()=>{
  const h=history(...Array.from({length:5},(_,i)=>reading(i*1.75)));
  const r=rate(h,120,start+7*3600000)!;
  expect(r.bblsDay).toBe(2537);expect(r.withdrawn).toBe(740);expect(r.inventoryChange).toBe(0);
 });
 test.each([[5,2126],[7,2949]])('accounts for inventory ending at %s feet', (bottom,expected)=>{
  const h=history(reading(0),reading(1.75),reading(3.5),reading(5.25),reading(7,bottom));
  expect(rate(h,120,start+7*3600000)?.bblsDay).toBe(expected);
 });
 test('two drivers and short overlapping intervals retain every distinct withdrawal',()=>{
  const h=history(reading(0),reading(1),reading(1.1),reading(3),reading(6));
  expect(rate(h,120,start+6*3600000)?.withdrawn).toBe(740);
  expect(rate(h,120,start+6*3600000)?.bblsDay).toBe(2960);
 });
 test('does not double count an alias of the same packet',()=>{
  const h=history(reading(0),reading(3),reading(6));
  h.p2=reading(6,6,185,{packetId:'last'});h.alias={...h.p2};
  expect(rate(h,120,start+6*3600000)?.withdrawn).toBe(370);
  h.alias={...h.p2,bblsTaken:140};expect(rate(h,120,start+6*3600000)).toBeNull();
 });
 test('real historical recoveries and edited canonical records remain included',()=>{
  const h=history(reading(0),reading(3,6,185,{historicalOnly:true}),reading(6,6,185,{wasEdited:true}));
  expect(rate(h,120,start+6*3600000)?.withdrawn).toBe(370);
 });
 test('trusted reported bottom wins over an old arithmetic processing bottom',()=>{
  const h=history(...[0,3,6].map(hour=>reading(hour,5,185,{source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',reportedBottomFeet:6}})));
  expect(rate(h,120,start+6*3600000)?.inventoryChange).toBe(0);
 });
 test.each([{wellDown:true},{noLevel:true},{flowIntervalBarrier:true},{tankAfterInches:null},{bblsTaken:null},
  {source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',barrels:{status:'provisional'}}}])('cannot bridge an unverified barrier %j',extra=>{
  expect(rate(history(reading(0),reading(3,6,185,extra),reading(6)),120,start+6*3600000)).toBeNull();
 });
 test('requires a three-hour window, latest endpoint, and safe calibration',()=>{
  const h=history(reading(0),reading(1),reading(2));
  expect(rate(h,120,start+2*3600000)).toBeNull();
  expect(rate(h,0,start+2*3600000)).toBeNull();
  expect(rate(h,120,start+7*3600000)).toBeNull();
 });
 test('two completed-load endpoints produce a valid partial-day balance',()=>{
  const r=rate(history(reading(0),reading(4.75,5.9,165)),67.2,start+4.75*3600000)!;
  expect(r.loads).toBe(1);expect(r.hours).toBe(4.75);
  expect(r.bblsDay).toBe(Math.round((165-6.72)*24/4.75));
 });
 const estimated=(hour:number,anchorHour:number,intervalMinutes=60)=>reading(hour,6,165,{source:'whatsapp_watchdog',watchdogProvenance:{
  principalId:'laptop-watchdog-v2',reportedBottomFeet:6,barrels:{status:'confirmed'},
  timeEstimate:{status:'estimated',method:'back_to_back_average',sampleCount:5,intervalMinutes,anchorPostedAt:new Date(start+anchorHour*3600000).toISOString()},
 }});
 test('bounded interior timing does not change a confirmed total between exact endpoints',()=>{
  const a=history(reading(0),estimated(8,10),reading(10,6,165));
  const r=rate(a,120,start+10*3600000)!;
  expect(r.withdrawn).toBe(330);expect(r.bblsDay).toBe(792);expect(r.estimatedInteriorLoads).toBe(1);
  a.p1=estimated(9,10);expect(rate(a,120,start+10*3600000)).toEqual(r);
 });
 test('estimated endpoints, unbounded timing and quantities remain excluded',()=>{
  expect(rate(history(estimated(0,1),reading(4)),120,start+4*3600000)).toBeNull();
  expect(rate(history(reading(0),estimated(4,5)),120,start+4*3600000)).toBeNull();
  expect(rate(history(reading(0),estimated(2,3),reading(4)),120,start+4*3600000)).toBeNull(); // declared range crosses start
  const bad:any=estimated(8,10);bad.watchdogProvenance.barrels.status='provisional';
  expect(rate(history(reading(0),bad,reading(10)),120,start+10*3600000)).toBeNull();
  delete bad.watchdogProvenance.barrels;delete bad.watchdogProvenance.timeEstimate.anchorPostedAt;
  expect(rate(history(reading(0),bad,reading(10)),120,start+10*3600000)).toBeNull();
 });
 test('order, future data and history view copies cannot alter the result',()=>{
  const h=history(reading(0),reading(3),reading(6));const baseline=rate(h,120,start+6*3600000);
  const copy=JSON.stringify(h);h.future=reading(9);h.history_view={...h.p1};
  expect(rate(Object.fromEntries(Object.entries(h).reverse()),120,start+6*3600000)).toEqual(baseline);
  delete h.future;delete h.history_view;expect(JSON.stringify(h)).toBe(copy);
 });
});
