import {barrelEstimate} from './barrelEstimate';
/** A fixed load requires a separately enabled operator policy, not capacity alone. */
export function fixedDriverDefault(channel:any,senderId:unknown,author:string):number|null {
 for(const key of [senderId,author]){
  if(typeof key!=='string'||channel?.driverDefaultModes?.[key]!=='fixed_load')continue;
  const bbls=channel.driverDefaultBbls?.[key];
  if(typeof bbls==='number'&&Number.isFinite(bbls)&&bbls>0&&bbls<=1000)return bbls;
 }
 return null;
}
export function decideBarrels(input:{written:number|null;fallback:number|null;top:number|null;bottom:number|null;bank:number;rateMinutesPerFoot:number;isDown:boolean;rateMeasuredAt:string;measuredAt:string;maxLoadBbls?:number;driverCapacity?:number;wellLimit?:number;fixedDefaultBbls?:number|null}) {
 const estimate=barrelEstimate(input);
 const limits=[input.maxLoadBbls,input.driverCapacity,input.wellLimit].filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1000);
 const limit=limits.length?Math.min(...limits):null;
 if(input.written!==null)return {bbls:input.written,source:'written' as const,provisional:false,needsReview:false,estimate,limit,issues:[] as string[]};
 const validBottom=typeof input.bottom==='number'&&Number.isFinite(input.bottom)&&input.bottom>=0&&typeof input.top==='number'&&input.bottom<=input.top;
 const fixed=input.fixedDefaultBbls;
 if(validBottom&&typeof fixed==='number'&&Number.isFinite(fixed)&&fixed>0&&fixed<=1000){
  const capped=limit!==null&&fixed>limit;
  return {bbls:capped?limit!:fixed,source:'default' as const,provisional:true,needsReview:capped,estimate,limit,issues:capped?['Configured driver default exceeds load limit; verify actual load']:[] as string[]};
 }
 const guess=estimate?.estimatedBbls??(estimate?Math.round(estimate.observedDropBbls):input.fallback);
 if(!validBottom||!guess||!Number.isFinite(guess)||guess<=0)return null;
 const bbls=Math.max(1,Math.min(1000,limit??1000,guess));
 const tolerance=limit===null?0:Math.max(5,limit*0.05);
 const knownCapacityDrop=limit===input.driverCapacity && estimate!=null && Math.abs(estimate.observedDropBbls-limit)<=tolerance;
 const routineCap=limit!==null&&guess>=limit&&(guess-limit<=tolerance||knownCapacityDrop);
 return {bbls,source:estimate?'estimated' as const:'default' as const,provisional:true,needsReview:!routineCap,estimate:estimate?{...estimate,mode:'provisional',caveat:'Estimated loading duration and reported bottom are unverified; tracking uses the reported bottom and estimated barrels do not train AFR.'}:null,limit,issues:[estimate?'Estimated barrels; verify loading duration and actual load':'Driver fallback barrels; verify actual load',...(limit!==null&&guess>limit?['Estimate exceeds configured load limit; capped provisionally']:[])]};
}
export function isProvisionalPull(packet:any):boolean {
 return packet?.source==='whatsapp_watchdog'&&packet?.watchdogProvenance?.principalId==='laptop-watchdog-v2'&&(packet?.watchdogProvenance?.timeEstimate?.status==='estimated'||packet?.watchdogProvenance?.barrels?.status==='provisional');
}
export function reportedTrackingBottom(packet:any,topInches:number):number|null {
 const bottom=Number(packet?.watchdogProvenance?.reportedBottomFeet)*12;
 return isProvisionalPull(packet)&&packet?.watchdogProvenance?.reportedBottomFeet!=null&&Number.isFinite(bottom)&&bottom>=0&&bottom<=topInches?bottom:null;
}
