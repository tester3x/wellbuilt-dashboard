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
 test('requires a six-hour window, latest endpoint, and safe calibration',()=>{
  const h=history(reading(0),reading(1.75),reading(3.5));
  expect(rate(h,120,start+3.5*3600000)).toBeNull();
  expect(rate(h,0,start+3.5*3600000)).toBeNull();
  expect(rate(h,120,start+7*3600000)).toBeNull();
 });
 test('order, future data and history view copies cannot alter the result',()=>{
  const h=history(reading(0),reading(3),reading(6));const baseline=rate(h,120,start+6*3600000);
  const copy=JSON.stringify(h);h.future=reading(9);h.history_view={...h.p1};
  expect(rate(Object.fromEntries(Object.entries(h).reverse()),120,start+6*3600000)).toEqual(baseline);
  delete h.future;delete h.history_view;expect(JSON.stringify(h)).toBe(copy);
 });
});
