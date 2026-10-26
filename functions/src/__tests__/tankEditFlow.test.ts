import {refreshFlowWindow} from '../refreshFlowWindow';
import {recalibratedHistory,flowRelevantTankEdit,persistRecalibratedHistory} from '../tankEditFlow';
const clone=(v:any)=>v==null?v:JSON.parse(JSON.stringify(v));
function memory(initial:any){
 const data=clone(initial);let conflict=false;
 const read=(path:string)=>path.split('/').filter(Boolean).reduce((v,k)=>v?.[k],data);
 const write=(path:string,value:any)=>{const parts=path.split('/');const key=parts.pop()!;const parent=parts.reduce((v,k)=>v[k]??(v[k]={}),data);parent[key]=clone(value);};
 const ref=(path=''):any=>{let field:string|undefined,equal:any;const obj:any={
  on:()=>{},off:()=>{},once:async()=>({val:()=>{const raw=read(path);return clone(field?Object.fromEntries(Object.entries(raw||{}).filter(([,v]:any)=>v[field!]===equal)):raw);}}),
  orderByChild:(f:string)=>{field=f;return obj;},equalTo:(v:any)=>{equal=v;return obj;},
  update:async(p:any)=>{if(path)write(path,{...read(path),...p});else for(const [key,v]of Object.entries(p))write(key,v);},
  transaction:async(fn:any)=>{const current=clone(read(path));if(conflict&&path.startsWith('packets/processed/'))current.bblsTaken=999;const next=fn(current);if(next!==undefined)write(path,next);return {committed:next!==undefined};},
 };return obj;};return {data,db:{ref},conflict:()=>{conflict=true;}};
}
const at=Date.parse('2026-01-01T12:00:00Z');
const row=(i:number,top=10)=>({packetId:'p'+i,wellName:'Example',requestType:'pull',dateTimeUTC:new Date(at+i*3*3600000).toISOString(),tankLevelFeet:top,tankTopInches:top*12,tankAfterInches:(top-2)*12,tankAfterFeet:`${top-2}'0"`,bblsTaken:100,companyId:'company',historicalImport:{companyId:'company',bblPerFoot:50}});
function fixture(mode:string){const rows={p0:row(0),p1:row(1,10.5),p2:row(2,11)};return memory({well_config:{Example:{tankInfoRevision:1,productionRateMode:mode,bblPerFoot:100,tanks:2,activeTanks:2,...(mode==='window'?{flowWindowMinimumRecoveryInches:6}:{})}},packets:{processed:rows,outgoing:{response:{wellName:'Example',lastPullPacketId:'p2',lastPullDateTimeUTC:rows.p2.dateTimeUTC,lastPullDriverId:'owner',wellDown:true}},incoming_version:1},wells:{Example:{status:{lastPull:{packetId:'p2'},current:{},calculated:{},isDown:true}}}});}

test.each(['inventory_balance','window','legacy'])('tank edit immediately recomputes %s from saved observations and notifies clients',async mode=>{
 const m=fixture(mode),before=clone(m.data.packets.processed);
 await refreshFlowWindow(m.db,'Example',{tankEdit:true});
 const status=m.data.wells.Example.status,response=m.data.packets.outgoing.response;
 expect(status.calculated.bbls24hrs).toBe(1200);expect(response.bbls24hrs).toBe('1200');
 expect(status.lastPull.bottomLevelInches).toBe(120);expect(status.config.tanks).toBe(2);
 expect(response.lastPullDriverId).toBe('owner');expect(response.wellDown).toBe(true);expect(response.timeTillPull).toBe('Down');
 expect(m.data.packets.incoming_version).toBeGreaterThan(1);
 for(const key of Object.keys(before))for(const f of ['packetId','tankLevelFeet','tankTopInches','bblsTaken','dateTimeUTC','companyId','historicalImport'])expect(m.data.packets.processed[key][f]).toEqual(before[key][f]);
 expect(Object.keys(m.data.packets.processed)).toEqual(Object.keys(before));
 const first=clone(status.calculated);await refreshFlowWindow(m.db,'Example',{tankEdit:true});expect(status.calculated.bbls24hrs).toBe(first.bbls24hrs);
});

test('reported measurements and unverified/barrier observations are preserved',()=>{
 const measured={...row(0),source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',reportedBottomFeet:8}};
 const uncertain={...row(1),source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',barrels:{status:'provisional'}}};
 const h={measured,uncertain};const view=recalibratedHistory(h,100);
 expect(view.measured.tankAfterInches).toBe(96);expect(view.measured.watchdogProvenance).toEqual(measured.watchdogProvenance);
 expect(view.uncertain).toEqual(uncertain);expect(h.measured).toEqual(measured);
});

test('a competing edit is refused rather than overwriting the observation',async()=>{
 const m=fixture('legacy'),h=clone(m.data.packets.processed),view=recalibratedHistory(h,100);m.conflict();
 await expect(persistRecalibratedHistory(m.db,h,view,1)).rejects.toThrow('tank_flow_history_changed');
 expect(m.data.packets.processed).toEqual(h);
});

test('unrelated notes/H2S changes do not request a recalculation',()=>{
 expect(flowRelevantTankEdit({bblPerFoot:100},{bblPerFoot:100,h2sStatus:'high',tankNotes:'new'})).toBe(false);
 expect(flowRelevantTankEdit({bblPerFoot:100},{bblPerFoot:120})).toBe(true);
});

test('a corrected calibration with no usable recovery clears a stale production rate',async()=>{
 const m=fixture('legacy');m.data.well_config.Example.bblPerFoot=1;
 m.data.wells.Example.status.calculated={flowRate:'stale',bbls24hrs:999};
 await refreshFlowWindow(m.db,'Example',{tankEdit:true});
 expect(m.data.wells.Example.status.calculated).toMatchObject({flowRate:'',bbls24hrs:0});
 expect(m.data.packets.outgoing.response.bbls24hrs).toBe('0');
 expect(m.data.packets.incoming_version).toBeGreaterThan(1);
});
