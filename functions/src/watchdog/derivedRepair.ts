import {isProvisionalPull,reportedTrackingBottom} from './barrelDecision';
import {averageFlowRates} from '../flowAverage';
export function displayRate(days:number):string {const s=Math.round(days*86400);return `${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
export function displayLevel(inches:number):string {const n=Math.floor(inches+1e-7);return `${Math.floor(n/12)}'${n%12}"`;}
/** Derived-only repair plan. Keys and original observations are never created/deleted/edited. */
export function planWatchdogDerivedRepair(history:Record<string,any>) {
 const rows=Object.entries(history).filter(([id,p])=>p.requestType==='pull'&&!p.deleted&&!/^(edit_|delete_|history_)/.test(id)&&Number.isFinite(Date.parse(p.dateTimeUTC)))
  .sort((a,b)=>Date.parse(a[1].dateTimeUTC)-Date.parse(b[1].dateTimeUTC)||a[0].localeCompare(b[0]));
 const patches:Record<string,any>={}, corrected:Record<string,any>={};let previous:any=null,previousBottomChanged=false;
 const seen=new Set<string>(),rates:{at:string;rate:number}[]=[];
 for(const [id,p] of rows) {
  const identity=p.packetId||id;if(seen.has(identity))continue;seen.add(identity);
  const next={...p},top=Number(p.tankTopInches??Number(p.tankLevelFeet)*12);
  // Manual edits may supersede the original report; do not overwrite them with stale provenance.
  const reported=p.wasEdited?null:reportedTrackingBottom(p,top);
  const bottom=reported??Number(p.tankAfterInches),changed=reported!==null&&bottom!==p.tankAfterInches;
  const provisional=isProvisionalPull(p),barrier=provisional||isProvisionalPull(previous)||p.noLevel||previous?.noLevel||p.wellDown===true||previous?.wellDown===true||p.flowIntervalBarrier===true;
  const patch:any={};
  if(reported!==null){patch.tankAfterInches=bottom;patch.tankAfterFeet=displayLevel(bottom);patch.canonicalProcessingBottomInches=bottom;}
  if(provisional||isProvisionalPull(previous)||changed||previousBottomChanged) {
   const elapsed=previous?(Date.parse(p.dateTimeUTC)-Date.parse(previous.dateTimeUTC))/86400000:0;
   const recovery=previous?top-Number(previous.tankAfterInches):0;
   const rate=!barrier&&elapsed>0&&elapsed<=30&&recovery>0?elapsed*12/recovery:0;
   patch.flowRateDays=rate>0&&rate<365?rate:0;patch.flowRate=patch.flowRateDays?displayRate(patch.flowRateDays):'';
   patch.recoveryInches=barrier?0:Math.max(0,recovery);patch.timeDifDays=elapsed;patch.timeDif=displayRate(elapsed).split(':').slice(0,2).join(':');
   patch.flowIntervalAction=barrier?'break':patch.flowRateDays?'update':'reset';
  }
  Object.assign(next,patch);corrected[id]=next;
  if(Object.entries(patch).some(([k,v])=>p[k]!==v))patches[id]=patch;
  if(!barrier&&Number(next.flowRateDays)>0&&Number(next.flowRateDays)<365)rates.push({at:p.dateTimeUTC,rate:Number(next.flowRateDays)});
  previous=next;previousBottomChanged=changed;
 }
 const eligible=rates.slice(-15);
 return {patches,corrected,averageDays:averageFlowRates(eligible.map(x=>x.rate)),flowMeasuredAt:eligible.at(-1)?.at||'',latest:rows.at(-1)?.[0],eligibleSamples:eligible.length};
}
