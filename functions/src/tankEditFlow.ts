import {canonicalHistory, feetDisplay, rateDisplay, digest, JsonRecord} from './imports/pullImportModel';
import {historicalAverage} from './imports/historicalAverage';
import {isProvisionalPull} from './watchdog/barrelDecision';

/** A calibration edit corrects calculated removals, never original gauge readings.
 * Authenticated reported bottoms remain measurements for the inventory estimator. */
export function recalibratedHistory(history:JsonRecord,bank:number):JsonRecord {
 const result:JsonRecord={};
 for(const [key,p] of Object.entries(history)){
  const proof=p?.watchdogProvenance;
  const measured=p?.source==='whatsapp_watchdog'&&proof?.principalId==='laptop-watchdog-v2'&&proof.reportedBottomFeet!=null;
  const top=Number(p?.tankLevelFeet),bbl=Number(p?.bblsTaken),bottom=top-bbl/bank;
  result[key]=p&&!/^(edit_|delete_|history_|idem_)/.test(key)&&p.requestType==='pull'&&!p.deleted&&!p.noLevel&&!isProvisionalPull(p)&&!measured&&
   Number.isFinite(top)&&top>0&&p.bblsTaken!=null&&Number.isFinite(bbl)&&bbl>=0
   ? {...p,tankAfterInches:bottom*12,tankAfterFeet:feetDisplay(bottom)}:p;
 }
 let previous:JsonRecord|undefined;
 for(const row of canonicalHistory(result)){
  if(!usable(row)){previous=undefined;continue;}
  const days=previous?(Date.parse(row.dateTimeUTC)-Date.parse(previous.dateTimeUTC))/86400000:0;
  const recovery=previous?Number(row.tankLevelFeet)-Number(previous.tankAfterInches)/12:0;
  const rate=days>0&&days<=30&&recovery>0&&days/recovery<365?days/recovery:0;
  result[row.key]={...result[row.key],flowRateDays:rate,flowRate:rate?rateDisplay(rate):'',recoveryInches:Math.max(0,recovery*12),timeDifDays:days};
  previous=row;
 }
 return result;
}

export function recalibratedLegacyRate(history:JsonRecord):number {
 const rates:number[]=[];let previous:JsonRecord|undefined;
 for(const row of canonicalHistory(history)){
  if(!usable(row)) {previous=undefined;continue;}
  if(previous){
   const days=(Date.parse(row.dateTimeUTC)-Date.parse(previous.dateTimeUTC))/86400000;
   const recovery=Number(row.tankLevelFeet)-Number(previous.tankAfterInches)/12;
   if(days>0&&days<=30&&recovery>0&&days/recovery<365)rates.push(days/recovery);
  }
  previous=row;
 }
 return historicalAverage(rates);
}

function usable(row:JsonRecord):boolean {
 const top=Number(row.tankLevelFeet),bottom=Number(row.tankAfterInches),bbl=Number(row.bblsTaken);
 return (row.requestType||'pull')==='pull'&&!row.noLevel&&row.wellDown!==true&&row.wellDown!=='true'&&!row.flowIntervalBarrier&&!isProvisionalPull(row)&&
  Date.parse(row.dateTimeUTC)<=Date.now()&&Number.isFinite(top)&&top>0&&row.tankAfterInches!=null&&Number.isFinite(bottom)&&bottom>=0&&bottom<=top*12&&row.bblsTaken!=null&&Number.isFinite(bbl)&&bbl>=0;
}

export function observationSignature(history:JsonRecord):string {
 return digest(Object.entries(history).sort(([a],[b])=>a.localeCompare(b)).map(([key,p])=>[key,p?.packetId,p?.dateTimeUTC,p?.tankLevelFeet,p?.bblsTaken,p?.deleted,p?.wellDown,p?.noLevel,p?.flowIntervalBarrier,p?.watchdogProvenance]));
}

/** Guarded derived-only updates. A competing load/edit must not be overwritten. */
export async function persistRecalibratedHistory(db:any,history:JsonRecord,view:JsonRecord,revision:number):Promise<void>{
 for(const [key,p]of Object.entries(history)){
  const next=view[key],fields=['tankAfterInches','tankAfterFeet','flowRateDays','flowRate','recoveryInches','timeDifDays'];
  if(!next||fields.every(f=>p[f]===next[f]))continue;
  const ref=db.ref('packets/processed/'+key),listener=()=>{};ref.on('value',listener);
  try{await ref.once('value');const result=await ref.transaction((current:any)=>{
   if(!current||digest(current)!==digest(p))return;
   return {...current,...Object.fromEntries(fields.filter(f=>next[f]!==undefined).map(f=>[f,next[f]])),
    tankInfoRecalibration:{revision,previousAfterInches:p.tankAfterInches??null,at:Date.now()}};
  });if(!result.committed)throw Error('tank_flow_history_changed');}finally{ref.off('value',listener);}
 }
}

export const flowRelevantTankEdit=(before:JsonRecord,after:JsonRecord)=>
 ['bblPerFoot','tankHeight','allowedBottom','loadLine','activeTanks'].some(key=>before[key]!==after[key]);
