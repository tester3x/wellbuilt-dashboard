import {calculateOvernightProduction as rate, calculateOvernightProductionSample as sample, overnightReadingProof, recordedBottomFeet} from '../overnightProduction';
import {readFileSync} from 'fs';
import {join} from 'path';
import {runInNewContext} from 'vm';
import {transpileModule, ScriptTarget} from 'typescript';
const reading = (utc: string, top: number, bottom?: number | null, bbls = 140) => ({
  timestamp: Date.parse(utc), tankLevelFeet: top, bottomLevelFeet: bottom, bblsTaken: bbls,
});

describe('overnight production uses actual bottom and Central civil day', () => {
  test('evening UTC midnight cannot replace the actual overnight interval', () => {
    const readings = [reading('2026-10-21T04:00:00Z', 10, 6), reading('2026-10-21T13:00:00Z', 10, 6),
      reading('2026-10-21T22:00:00Z', 8, 5), reading('2026-10-22T00:30:00Z', 7, 4)];
    expect(rate(readings, 60, Date.parse('2026-10-22T02:00:00Z'))).toBe(640);
  });
  test('recorded bottom controls recovery even when barrels imply a different drop', () => {
    const a = reading('2026-10-21T04:00:00Z', 10, 7, 240);
    const b = reading('2026-10-21T13:00:00Z', 10, 6);
    expect(rate([a, b], 60, b.timestamp)).toBe(480);
    expect(rate([{...a, bblsTaken: 185}, b], 60, b.timestamp)).toBe(480);
  });
  test('a short interval cannot turn an unmeasured extra drop into a thousand BBL/day', () => {
    const a=reading('2026-10-21T04:45:00Z',10,9,185);
    const b=reading('2026-10-21T06:15:00Z',10,9,185);
    expect(rate([a,b],120,b.timestamp)).toBe(1920);
    // Legacy subtraction invents65 BBL of additional recovery over1.5 hours.
    const reconstructed={...a,bottomLevelFeet:undefined};
    expect(rate([reconstructed,b],120,b.timestamp)).toBe(2960);
  });
  test('continuous hauling deliberately publishes no separate ON estimate', () => {
    const a=reading('2026-10-21T04:00:00Z',10,6),b=reading('2026-10-21T13:00:00Z',10,6);
    expect(rate([a,b],60,b.timestamp)).toBe(640);
    expect(rate([a,b],60,b.timestamp,'afr')).toBe(0);
  });
  test.each([
    ['summer', '2026-07-01T04:00:00Z', '2026-07-01T13:00:00Z'],
    ['winter', '2026-01-01T05:00:00Z', '2026-01-01T14:00:00Z'],
    ['DST spring', '2026-03-08T05:00:00Z', '2026-03-08T13:00:00Z'],
    ['DST fall', '2026-11-01T04:00:00Z', '2026-11-01T14:00:00Z'],
  ])('%s uses Central dates and actual elapsed hours', (_name, previous, first) => {
    const a=reading(previous, 10, 6), b=reading(first, 10, 6);
    expect(rate([b,a], 60, b.timestamp)).toBe(Math.round(240*86400000/(b.timestamp-a.timestamp)));
  });
  test('future readings are excluded and input is not mutated', () => {
    const a=reading('2026-10-21T04:00:00Z',10,6), b=reading('2026-10-21T13:00:00Z',10,6);
    const rows=[b,a,reading('2026-10-22T14:00:00Z',20,1)], before=rows.slice();
    expect(rate(rows,60,b.timestamp)).toBe(640); expect(rows).toEqual(before);
  });
  test.each(['provisional','wellDown'] as const)('%s boundary cannot publish an overnight rate', key => {
    const a=reading('2026-10-21T04:00:00Z',10,6), b=reading('2026-10-21T13:00:00Z',10,6);
    expect(rate([{...a,[key]:true},b],60,b.timestamp)).toBe(0);
    expect(rate([a,{...b,[key]:true}],60,b.timestamp)).toBe(0);
  });
  test('absent legacy bottom retains arithmetic fallback; explicit invalid bottom does not', () => {
    const a=reading('2026-10-21T04:00:00Z',10,undefined,240), b=reading('2026-10-21T13:00:00Z',10,6);
    expect(rate([a,b],60,b.timestamp)).toBe(640);
    expect(rate([{...a,bottomLevelFeet:null},b],60,b.timestamp)).toBe(0);
    expect(rate([a,b],0,b.timestamp)).toBe(0);
  });
  test('equal or falling levels and missing overnight boundary have no estimate', () => {
    const a=reading('2026-10-21T04:00:00Z',10,8), b=reading('2026-10-21T13:00:00Z',7,6);
    expect(rate([a,b],60,b.timestamp)).toBe(0);expect(rate([b],60,b.timestamp)).toBe(0);
  });
  test('stored numeric and formatted bottom parsing preserve fractional inches and zero', () => {
    expect(recordedBottomFeet({tankLevelFeet:10,tankAfterInches:0})).toBe(0);
    expect(recordedBottomFeet({tankLevelFeet:10,tankAfterFeet:'7\'11.5"'})).toBeCloseTo(7+11.5/12);
    expect(recordedBottomFeet({tankLevelFeet:10,tankAfterFeet:'7\'12"'})).toBeNull();
    expect(recordedBottomFeet({tankLevelFeet:10,tankAfterInches:132})).toBeNull();
    expect(recordedBottomFeet({tankLevelFeet:10})).toBeUndefined();
  });

  test('the actual history loader carries the persisted bottom into overnight math', async () => {
    const source=readFileSync(join(__dirname,'../index.ts'),'utf8');
    const begin=source.indexOf('async function getHistoricalPulls('), end=source.indexOf('\n/**',begin);
    const packets={
      before:{dateTimeUTC:'2026-10-21T04:00:00Z',tankLevelFeet:10,tankAfterInches:84,bblsTaken:240},
      first:{dateTimeUTC:'2026-10-21T13:00:00Z',tankLevelFeet:10,tankAfterInches:72,bblsTaken:140},
      ignored:{dateTimeUTC:'2026-10-21T12:00:00Z',tankLevelFeet:18,bblsTaken:900,requestType:'wellHistory'},
    };
    const chain:any={orderByChild:()=>chain,equalTo:()=>chain,once:async()=>({val:()=>packets})};
    const loader=runInNewContext(transpileModule(source.slice(begin,end),{compilerOptions:{target:ScriptTarget.ES2020}}).outputText+';getHistoricalPulls',{
      db:{ref:()=>chain},parsePacketTimestamp:(p:any)=>Date.parse(p.dateTimeUTC),
      recordedBottomFeet,overnightReadingProof,console,
    });
    const history=await loader('Test Well');
    expect(history).toHaveLength(2);
    expect(history[0].bottomLevelFeet).toBe(7);
    expect(rate(history,60,Date.parse(packets.first.dateTimeUTC))).toBe(480);
  });
});

describe('estimated overnight endpoint times remain distinct from quantity uncertainty',()=>{
 const previous=reading('2026-10-22T22:41:07Z',6,3.5,165);
 const packet:any={source:'whatsapp_watchdog',dateTimeUTC:'2026-10-23T19:57:46Z',watchdogProvenance:{principalId:'laptop-watchdog-v2',reportedBottomFeet:9.5,barrels:{status:'confirmed'},timeEstimate:{status:'estimated',method:'back_to_back_average',sampleCount:20,intervalMinutes:106,anchorPostedAt:'2026-10-23T21:43:46Z'}}};
 const first=()=>({...reading(packet.dateTimeUTC,12,9.5,165),...overnightReadingProof(packet)});
 test('last prior day to first next day publishes the estimate and marks its time',()=>{
  expect(sample([previous,first()],67.21492853654452,first().timestamp)).toEqual({bblsDay:644,estimatedTime:true});
  const later=reading('2026-10-23T21:43:46Z',9.75,7.25,165);
  expect(sample([previous,first(),later],67.21492853654452,later.timestamp)).toEqual({bblsDay:644,estimatedTime:true});
 });
 test('continuous-haul AFR mode remains suppressed with estimated endpoints',()=>{
  expect(sample([previous,first()],67.2,first().timestamp,'afr')).toEqual({bblsDay:0,estimatedTime:false});
 });
 test('uncertain quantity, invalid time proof and down endpoints still cannot publish',()=>{
  for(const changed of [
   {...packet,watchdogProvenance:{...packet.watchdogProvenance,barrels:{status:'provisional'}}},
   {...packet,watchdogProvenance:{...packet.watchdogProvenance,timeEstimate:{...packet.watchdogProvenance.timeEstimate,sampleCount:0}}},
   {...packet,source:'other'},
  ])expect(sample([previous,{...first(),...overnightReadingProof(changed),provisional:true}],67.2,first().timestamp).bblsDay).toBe(0);
  expect(overnightReadingProof({...packet,watchdogProvenance:{...packet.watchdogProvenance,barrels:{status:'provisional'}}}).provisional).toBe(true);
  expect(overnightReadingProof({...packet,watchdogProvenance:{...packet.watchdogProvenance,timeEstimate:{...packet.watchdogProvenance.timeEstimate,sampleCount:0}}})).toEqual({provisional:true,estimatedTime:false});
  expect(sample([{...previous,wellDown:true},first()],67.2,first().timestamp).bblsDay).toBe(0);
 });
 test('a skipped calendar date retains the estimated clock and uses the complete elapsed gap',()=>{
  const earlier={...previous,timestamp:previous.timestamp-86400000};
  const expected=Math.round((12-3.5)*67.2*86400000/(first().timestamp-earlier.timestamp));
  expect(sample([earlier,first()],67.2,first().timestamp)).toEqual({bblsDay:expected,estimatedTime:true});
 });
});

describe('slow-well recovery normalized across days without pulls',()=>{
 test.each([12,18,24,25,36,48,51.5,72,123])('300 BBL recovered over %s hours is normalized to 24 hours',hours=>{
  const previous=reading('2026-10-20T22:00:00Z',8,5,165);
  const first={...reading('2026-10-21T22:00:00Z',10,7,165),timestamp:previous.timestamp+hours*3600000};
  expect(sample([previous,first],60,first.timestamp)).toEqual({bblsDay:Math.round(300*24/hours),estimatedTime:false});
 });
 test('later same-day pulls do not replace the first pull following a multi-day gap',()=>{
  const previous=reading('2026-10-20T22:00:00Z',8,5,165);
  const first=reading('2026-10-23T19:00:00Z',10,7,165),later=reading('2026-10-23T22:00:00Z',12,9,165);
  expect(sample([later,previous,first],60,later.timestamp)).toEqual({bblsDay:Math.round(300*24/69),estimatedTime:false});
 });
});
