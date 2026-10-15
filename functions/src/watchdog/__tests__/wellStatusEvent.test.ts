import {processWatchdogWellStatus} from '../wellStatusEvent';
import {canonicalHistory} from '../../imports/pullImportModel';
const now=Date.parse('2026-10-15T18:00:00Z');
function harness(){
 const data=new Map<string,any>([
  ['well_config/Thor 1',{companyId:'liquid-gold',avgFlowRateMinutes:214.22,bblPerFoot:20}],
  ['wells/Thor 1/status',{isDown:false,lastPull:{dateTimeUTC:'2026-10-14T18:00:00Z',top:136,bottom:25},calculated:{flowRateMinutes:214.22}}],
  ['packets/outgoing/existing',{wellName:'Thor 1',wellDown:false,lastPullDateTimeUTC:'2026-10-14T18:00:00Z',lastPullBottomLevel:'2\u20321\u2033',flowRate:'3:34:13'}],
 ]);
 const snapshot=(v:any)=>({val:()=>v,exists:()=>v!==undefined});
 const db={ref:(path:string):any=>({once:async()=>snapshot(data.get(path)),remove:async()=>data.delete(path),
  update:async(patch:any)=>{for(const[k,v]of Object.entries(patch)){if(v===null)data.delete(k);else data.set(k,v);}},
  transaction:async(fn:any)=>{const result=fn(data.get(path));if(result===undefined)return{committed:false};data.set(path,result);return{committed:true};},
  orderByChild:()=>({equalTo:(well:string)=>({once:async()=>snapshot(Object.fromEntries([...data].filter(([k,v])=>k.startsWith(path+'/')&&v.wellName===well).map(([k,v])=>[k.split('/').pop(),v])))})}),
 })};return{db,data};
}
const event=(id:string,down:boolean,offset:number)=>({packetId:id,requestType:'well_status',source:'whatsapp_watchdog',companyId:'liquid-gold',wellName:'Thor 1',dateTimeUTC:new Date(now+offset).toISOString(),wellDown:down,wellDownIsAuthoritative:true,tankLevelFeet:null,bottomLevelFeet:null,bblsTaken:0,watchdogProvenance:{principalId:'laptop-watchdog-v2',observationDigest:id}});
test('down then up preserve all gauges, clocks, barrel calibration and AFR, with no pull history row',async()=>{
 const {db,data}=harness();const before=structuredClone(data.get('wells/Thor 1/status'));
 for(const[id,down,offset]of [['down',true,-120000],['up',false,-60000]] as const){
  await processWatchdogWellStatus(db,id,event(id,down,offset),now);
  expect(data.get('wells/Thor 1/status')).toMatchObject({...before,isDown:down});
  expect(data.get('well_config/Thor 1')).toMatchObject({isDown:down,avgFlowRateMinutes:214.22,bblPerFoot:20});
  expect(data.get('packets/outgoing/existing')).toMatchObject({wellDown:down,lastPullDateTimeUTC:'2026-10-14T18:00:00Z',flowRate:'3:34:13'});
  expect(data.get('packets/processed/'+id)).toMatchObject({canonicalProcessingComplete:true,noLevel:true,statusOnly:true,statusApplied:true});
 }
 expect(canonicalHistory(Object.fromEntries([...data].filter(([k])=>k.startsWith('packets/processed/'))))).toEqual([]);
});
test('late older event and retry cannot reverse a newer status',async()=>{
 const {db,data}=harness();await processWatchdogWellStatus(db,'up',event('up',false,-60000),now);
 await processWatchdogWellStatus(db,'old-down',event('old-down',true,-120000),now);
 expect(data.get('well_config/Thor 1').isDown).toBe(false);expect(data.get('packets/processed/old-down').statusApplied).toBe(false);
 await processWatchdogWellStatus(db,'old-down',event('old-down',true,-120000),now);expect(data.get('well_config/Thor 1').isDown).toBe(false);
});
test('invalid or untrusted event makes no state writes',async()=>{
 for(const patch of [{wellDownIsAuthoritative:false},{bblsTaken:140},{tankLevelFeet:12},{source:'client'},{companyId:'other'},{dateTimeUTC:new Date(now+600000).toISOString()}]){
  const {db,data}=harness();const before=structuredClone([...data]);
  await expect(processWatchdogWellStatus(db,'bad',{...event('bad',true,-60000),...patch},now)).rejects.toThrow('invalid_well_status_event');
  expect([...data]).toEqual(before);
 }
});

test('pull-attached and standalone status share the same chronological selection',async()=>{
 const {selectWellOperatingStatus}=require('../wellStatusEvent');const {db,data}=harness();
 await selectWellOperatingStatus(db,'Thor 1',{packetId:'measured-up',dateTimeUTC:new Date(now-60000).toISOString(),wellDown:false});
 await processWatchdogWellStatus(db,'late-down',event('late-down',true,-120000),now);
 expect(data.get('packets/processed/late-down').statusApplied).toBe(false);
 const older=await selectWellOperatingStatus(db,'Thor 1',{packetId:'older-pull',dateTimeUTC:new Date(now-180000).toISOString(),wellDown:true});
 expect(older.applied).toBe(false);expect(older.selected.wellDown).toBe(false);
});
