import {effectiveFlow} from './effectiveFlow';
import {calculateInventoryProduction} from './inventoryProduction';
import {resolveTankBblPerFoot} from './tankCalibration';
import {canonicalHistory} from './imports/pullImportModel';
import {calculateOvernightProductionSample,overnightReadingProof,recordedBottomFeet} from './overnightProduction';
import {recalibratedHistory,recalibratedLegacyRate,persistRecalibratedHistory,observationSignature} from './tankEditFlow';
const display=(days:number)=>{const s=Math.round(days*86400);return `${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
/** RTDB transactions may first receive null when a server process has no cache.
 * Keep a value listener until the guarded transaction finishes, otherwise a
 * null-aborting guard can silently skip an existing projection on a cold start. */
async function guardedTransaction(ref:any,update:(current:any)=>any):Promise<void>{
 const listener=()=>{};ref.on('value',listener);
 try{await ref.once('value');await ref.transaction(update);}finally{ref.off('value',listener);}
}
/** ON is independent of the chosen AFR estimator, including ordinary slow
 * wells. Recompute after late arrivals, edits and deletions without rewriting
 * their flow model, measurements or equipment/tank configuration. */
async function refreshOvernightProjection(db:any,wellName:string,cfg:any,history:any):Promise<void>{
 const canonical=canonicalHistory(history).filter(p=>(p.requestType||'pull')==='pull');
 const last=canonical.filter(p=>(p.requestType||'pull')==='pull'&&Number.isFinite(Date.parse(p.dateTimeUTC||''))&&Date.parse(p.dateTimeUTC)<=Date.now())
  .sort((a,b)=>Date.parse(b.dateTimeUTC)-Date.parse(a.dateTimeUTC))[0];
 if(!last)return;
 const sample=calculateOvernightProductionSample(canonical.map(p=>({
  timestamp:Date.parse(p.dateTimeUTC||''),tankLevelFeet:Number(p.tankLevelFeet),bblsTaken:Number(p.bblsTaken),
  bottomLevelFeet:recordedBottomFeet(p),...overnightReadingProof(p),
  wellDown:p.noLevel||p.wellDown===true||p.wellDown==='true'||p.flowIntervalBarrier===true,
 })),resolveTankBblPerFoot(cfg),Date.parse(last.dateTimeUTC),cfg.overnightProductionMode==='afr'?'afr':'overnight');
 const value=sample.bblsDay>0?String(sample.bblsDay):null,estimated=sample.bblsDay>0&&sample.estimatedTime;
 const outgoing=(await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
 for(const key of Object.keys(outgoing))await guardedTransaction(db.ref('packets/outgoing/'+key),(current:any)=>{
  if(current?.lastPullPacketId!==last.packetId||current.lastPullDateTimeUTC!==last.dateTimeUTC)return undefined;
  if((current.overnightBblsDay??null)===value&&(current.overnightEstimatedTime===true)===estimated)return undefined;
  return {...current,overnightBblsDay:value,overnightEstimatedTime:estimated,isEdit:true,timestamp:new Date().toISOString(),timestampUTC:new Date().toISOString()};
 });
}
/** Refresh only derived fields; original measurements, ownership and down state are preserved. */
export async function refreshFlowWindow(db:any,wellName:string,options:{tankEdit?:boolean}={}):Promise<void>{
 const cfg=(await db.ref('well_config/'+wellName).once('value')).val()||{};
 const inventoryMode=cfg.productionRateMode==='inventory_balance';
 let history=(await db.ref('packets/processed').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
 const originalObservations=options.tankEdit?observationSignature(history):'';
 const assertCurrent=async()=>{if(!options.tankEdit)return;const current=(await db.ref('well_config/'+wellName).once('value')).val();if(current?.tankInfoRevision!==cfg.tankInfoRevision||current?.bblPerFoot!==cfg.bblPerFoot)throw Error('tank_flow_config_changed');const observations=(await db.ref('packets/processed').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};if(observationSignature(observations)!==originalObservations)throw Error('tank_flow_history_changed');};
 if(options.tankEdit){
  await assertCurrent();const view=recalibratedHistory(history,resolveTankBblPerFoot(cfg));
  await persistRecalibratedHistory(db,history,view,Number(cfg.tankInfoRevision)||0);history=view;await assertCurrent();
 }
 await refreshOvernightProjection(db,wellName,cfg,history);
 if(!cfg.flowWindowMinimumRecoveryInches&&!inventoryMode&&!options.tankEdit)return;
 const latestTime=Math.max(...Object.values(history).map((p:any)=>Date.parse(p.dateTimeUTC||'')).filter(t=>Number.isFinite(t)&&t<=Date.now()));
 const inventory=inventoryMode?calculateInventoryProduction(history,resolveTankBblPerFoot(cfg),latestTime):null;
 const flow=inventoryMode?{averageDays:inventory?.daysPerFoot||0,results:[]}:effectiveFlow(history,cfg)??(options.tankEdit?{averageDays:recalibratedLegacyRate(history),results:[]}:null);if(!flow)return;
 const updates:any={};
 for(const r of flow.results){const key=Object.keys(history).find(k=>(history[k].packetId||k)===r.packetId);if(!key)continue;for(const [field,value] of Object.entries({flowRateDays:r.flowRateDays,flowRate:r.flowRateDays?display(r.flowRateDays):'',recoveryInches:r.recoveryInches,timeDifDays:r.timeDifDays,flowIntervalAction:r.action}))updates[`packets/processed/${key}/${field}`]=value;}
 if(Object.keys(updates).length)await db.ref().update(updates);
 if(!(flow.averageDays>0)){
  if(options.tankEdit){
   await assertCurrent();
   const rows=canonicalHistory(history).filter(p=>(p.requestType||'pull')==='pull'&&Date.parse(p.dateTimeUTC)<=Date.now()),latest=rows.at(-1);
   const outgoing=(await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
   for(const key of Object.keys(outgoing))await guardedTransaction(db.ref('packets/outgoing/'+key),(p:any)=>latest&&p?.lastPullPacketId===latest.packetId?{...p,flowRate:'',bbls24hrs:'0',windowBblsDay:null,nextPullTimeUTC:null,nextPullTime:'',timeTillPull:'',isEdit:true,timestamp:new Date().toISOString(),timestampUTC:new Date().toISOString()}:undefined);
   await guardedTransaction(db.ref('wells/'+wellName+'/status'),(s:any)=>latest&&s?.lastPull?.packetId===latest.packetId?{...s,calculated:{...s.calculated,flowRate:'',flowRateMinutes:0,bbls24hrs:0,nextPullTimeUTC:null,nextPullTime:'',timeTillPull:''}}:undefined);
   await db.ref('well_config/'+wellName).update({avgFlowRate:'',avgFlowRateMinutes:0});
   await db.ref('packets/incoming_version').transaction((v:any)=>Math.max(Number(v)||0,Date.now())+1);
  }
  return;
 }
 const last=Object.values(history).filter((p:any)=>p.requestType==='pull'&&!p.noLevel&&!p.deleted&&Number(p.tankTopInches)>0).sort((a:any,b:any)=>Date.parse(b.dateTimeUTC)-Date.parse(a.dateTimeUTC))[0] as any;
 if(!last)return;
 // An inventory AFR and the overnight observation are different intervals.
 // Refresh both from their own evidence; only continuous-hauling mode suppresses ON.
 const overnightSample=calculateOvernightProductionSample(canonicalHistory(history).map(p=>({
 timestamp:Date.parse(p.dateTimeUTC||''),tankLevelFeet:Number(p.tankLevelFeet),bblsTaken:Number(p.bblsTaken),
 bottomLevelFeet:recordedBottomFeet(p),...overnightReadingProof(p),
 wellDown:p.noLevel||p.wellDown===true||p.wellDown==='true'||p.flowIntervalBarrier===true,
 })),resolveTankBblPerFoot(cfg),Date.parse(last.dateTimeUTC),cfg.overnightProductionMode==='afr'?'afr':'overnight');
 const overnight=overnightSample.bblsDay;
 await assertCurrent();
 const rate=display(flow.averageDays),bank=Number(cfg.bblPerFoot)||20*(cfg.tanks||cfg.numTanks||1);
 const needed=Math.max(0,(Number(cfg.bottomLevel??cfg.allowedBottom??1)+Number(cfg.pullBbls||140)/bank)*12-Number(last.tankAfterInches));
 const waitDays=needed/12*flow.averageDays,next=new Date(Date.parse(last.dateTimeUTC)+waitDays*86400000).toISOString(),bbl=Math.round(bank/flow.averageDays);
 const refreshedAt=new Date().toISOString(),refreshedLevel=displayLevel();
 function displayLevel(){const inches=Number(last.tankAfterInches)+Math.max(0,Date.now()-Date.parse(last.dateTimeUTC))/86400000/flow!.averageDays*12;const rounded=Math.round(inches);return `${Math.floor(rounded/12)}'${rounded%12}\"`;}
 const outgoing=(await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
 for(const [key,value] of Object.entries(outgoing)){const p=value as any;if(p.lastPullPacketId!==last.packetId)continue;
 await guardedTransaction(db.ref('packets/outgoing/'+key),(current:any)=>current?.lastPullPacketId===last.packetId&&current.lastPullDateTimeUTC===last.dateTimeUTC?{...current,...(options.tankEdit?{lastPullBottomLevel:last.tankAfterFeet,currentLevel:refreshedLevel,timestamp:refreshedAt,timestampUTC:refreshedAt}:{}),flowRate:rate,bbls24hrs:String(bbl),windowBblsDay:null,overnightBblsDay:overnight>0?String(overnight):null,overnightEstimatedTime:overnight>0&&overnightSample.estimatedTime,nextPullTimeUTC:next,nextPullTime:new Intl.DateTimeFormat('en-US',{timeZone:current.timezone||'America/Chicago',dateStyle:'short',timeStyle:'short'}).format(new Date(next)),timeTillPull:current.wellDown?'Down':display(waitDays).split(':').slice(0,2).join(':'),isEdit:true,...(!options.tankEdit?{timestamp:new Date().toISOString(),timestampUTC:new Date().toISOString()}:{} )}:undefined);
 }
 await guardedTransaction(db.ref('wells/'+wellName+'/status'),(status:any)=>status?.lastPull?.packetId===last.packetId?{...status,...(options.tankEdit?{current:{...status.current,level:refreshedLevel,levelInches:Number(last.tankAfterInches)+Math.max(0,Date.parse(refreshedAt)-Date.parse(last.dateTimeUTC))/86400000/flow.averageDays*12,asOf:refreshedAt},lastPull:{...status.lastPull,bottomLevel:last.tankAfterFeet,bottomLevelInches:last.tankAfterInches},config:{...status.config,tanks:cfg.activeTanks??cfg.tanks}}:{}),calculated:{...status.calculated,flowRate:rate,flowRateMinutes:Math.round(flow.averageDays*144000)/100,bbls24hrs:bbl,nextPullTimeUTC:next,nextPullTime:new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',dateStyle:'short',timeStyle:'short'}).format(new Date(next)),timeTillPull:status.isDown?'Down':display(waitDays).split(':').slice(0,2).join(':')}}:undefined);
 await db.ref('well_config/'+wellName).update({avgFlowRate:rate,avgFlowRateMinutes:Math.round(flow.averageDays*144000)/100});
 if(options.tankEdit){await assertCurrent();await db.ref('packets/incoming_version').transaction((v:any)=>Math.max(Number(v)||0,Date.now())+1);}
}

