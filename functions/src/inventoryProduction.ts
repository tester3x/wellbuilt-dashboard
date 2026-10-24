import {isProvisionalPull} from './watchdog/barrelDecision';

export interface InventoryProduction {
  bblsDay:number; daysPerFoot:number; hours:number; withdrawn:number;
  inventoryChange:number; start:string; end:string; loads:number;
  estimatedInteriorLoads:number;
}

/** Same-phase (completed-load bottom to completed-load bottom) water balance.
 * Actual withdrawals plus change in tank inventory include inflow during loading.
 * No assumed loading duration, fabricated bottom, or target production rate.
 * Explicit per-well opt-in; callers must establish complete observation capture.
 */
export function calculateInventoryProduction(history:Record<string,any>,bank:number,at:number):InventoryProduction|null {
  if(!Number.isFinite(bank)||bank<=0||!Number.isFinite(at))return null;
  const rows=Object.entries(history).filter(([key,p])=>p&&!/^(history_|edit_|delete_)/.test(key)&&
    (p.requestType||'pull')==='pull'&&!p.deleted)
    .map(([key,p])=>({key,p,time:Date.parse(p.dateTimeUTC||'')}))
    .filter(r=>Number.isFinite(r.time)&&r.time<=at&&r.time>=at-86400000)
    .sort((a,b)=>a.time-b.time||a.key.localeCompare(b.key));
  const seen=new Map<string,string>();
  let valid:{time:number;bottom:number;bbl:number;estimated:boolean;earliest:number;latest:number}[]=[];
  for(const {key,p,time} of rows){
    const identity=String(p.packetId||key), fingerprint=JSON.stringify([time,p.tankLevelFeet,p.bblsTaken,p.tankAfterInches,p.watchdogProvenance?.reportedBottomFeet]);
    if(seen.has(identity)){if(seen.get(identity)!==fingerprint)return null;continue;}
    seen.set(identity,fingerprint);
    const proof=p.watchdogProvenance;
    const reported=p.source==='whatsapp_watchdog'&&proof?.principalId==='laptop-watchdog-v2'&&proof.reportedBottomFeet!=null;
    const raw=reported?proof.reportedBottomFeet:p.tankAfterInches;
    const bottom=raw==null||raw===''?NaN:Number(raw)/(reported?1:12);
    const top=Number(p.tankLevelFeet),bbl=Number(p.bblsTaken);
    const topOnly=bbl===0&&reported&&proof.observationKind==='top_only'&&proof.ownershipSource==='verified_sender_binding'&&
      typeof p.driverId==='string'&&proof.ownerDriverId===p.driverId;
    // Quantity uncertainty blocks conservation; interior timing uncertainty need
    // not, when the entire declared admissible interval lies between exact ends.
    const estimated=proof?.timeEstimate?.status==='estimated';
    const e=proof?.timeEstimate,anchor=Date.parse(e?.anchorPostedAt||'');
    const bounded=reported&&e?.method==='back_to_back_average'&&Number.isInteger(e.sampleCount)&&e.sampleCount>=3&&e.sampleCount<=20&&
      Number.isInteger(e.intervalMinutes)&&e.intervalMinutes>=15&&e.intervalMinutes<=240&&Number.isFinite(anchor)&&time<anchor&&anchor-time<=4*e.intervalMinutes*60000;
    const earliest=estimated&&bounded?anchor-4*e.intervalMinutes*60000:time;
    const latest=estimated&&bounded?anchor:time;
    const quantityUnverified=isProvisionalPull(estimated?{...p,watchdogProvenance:{...proof,timeEstimate:undefined}}:p);
    const bad=quantityUnverified||(estimated&&!bounded)||p.noLevel||p.wellDown===true||p.wellDown==='true'||p.flowIntervalBarrier===true||
      !Number.isFinite(bottom)||bottom<0||!Number.isFinite(top)||top<=0||bottom>top||
      p.bblsTaken==null||!Number.isFinite(bbl)||bbl<0||bbl>1000||(bbl===0&&!topOnly);
    if(bad){valid=[];continue;}
    // Distinct simultaneous records have no trustworthy endpoint ordering.
    if(valid.at(-1)?.time===time){valid=[];continue;}
    valid.push({time,bottom,bbl,estimated,earliest,latest});
  }
  // Estimated points cannot supply the measured time or level at either end.
  // If an interior point can fall outside a candidate span, start after it.
  let firstExact=valid.findIndex(r=>!r.estimated);
  valid=firstExact<0?[]:valid.slice(firstExact);
  for(let i=1;i<valid.length-1;i++)if(valid[i].estimated&&
    (valid[i].earliest<valid[0].time||valid[i].latest>valid.at(-1)!.time)){
    valid=valid.slice(i+1);firstExact=valid.findIndex(r=>!r.estimated);
    valid=firstExact<0?[]:valid.slice(firstExact);i=0;
  }
  const first=valid[0],last=valid.at(-1);
  if(!first||!last||first.estimated||last.estimated||last.time!==at||valid.length<2)return null;
  const hours=(last.time-first.time)/3600000;
  // Two observed completed-load endpoints establish a balance. Keep a three-hour
  // floor against short/overlapping gauge noise, without demanding a third load.
  if(hours<3||hours>24)return null;
  const withdrawn=valid.slice(1).reduce((sum,r)=>sum+r.bbl,0);
  const inventoryChange=(last.bottom-first.bottom)*bank;
  const production=withdrawn+inventoryChange;
  if(!(production>0))return null;
  const bblsDay=production*24/hours;
  return {bblsDay:Math.round(bblsDay),daysPerFoot:bank/bblsDay,hours,withdrawn,inventoryChange,
    start:new Date(first.time).toISOString(),end:new Date(last.time).toISOString(),loads:valid.length-1,
    estimatedInteriorLoads:valid.filter(r=>r.estimated).length};
}
