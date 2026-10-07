import {barrelEstimate} from './barrelEstimate';
export function decideBarrels(input:{written:number|null;fallback:number|null;top:number|null;bottom:number|null;bank:number;rateMinutesPerFoot:number;isDown:boolean;rateMeasuredAt:string;measuredAt:string;maxLoadBbls?:number;driverCapacity?:number;wellLimit?:number}) {
 const estimate=barrelEstimate(input);
 const limits=[input.maxLoadBbls,input.driverCapacity,input.wellLimit].filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1000);
 const limit=limits.length?Math.min(...limits):null;
 if(input.written!==null)return {bbls:input.written,source:'written' as const,provisional:false,needsReview:false,estimate,limit,issues:[] as string[]};
 const validBottom=typeof input.bottom==='number'&&Number.isFinite(input.bottom)&&input.bottom>=0&&typeof input.top==='number'&&input.bottom<=input.top;
 const guess=estimate?.estimatedBbls??(estimate?Math.round(estimate.observedDropBbls):input.fallback);
 if(!validBottom||!guess||!Number.isFinite(guess)||guess<=0)return null;
 const bbls=Math.max(1,Math.min(1000,limit??1000,guess));
 return {bbls,source:estimate?'estimated' as const:'default' as const,provisional:true,needsReview:true,estimate:estimate?{...estimate,mode:'provisional',caveat:'Estimated loading duration and reported bottom are unverified; tracking uses the reported bottom and estimated barrels do not train AFR.'}:null,limit,issues:[estimate?'Estimated barrels; verify loading duration and actual load':'Driver fallback barrels; verify actual load',...(limit!==null&&guess>limit?['Estimate exceeds configured load limit; capped provisionally']:[])]};
}
export function isProvisionalPull(packet:any):boolean {
 return packet?.source==='whatsapp_watchdog'&&packet?.watchdogProvenance?.principalId==='laptop-watchdog-v2'&&packet?.watchdogProvenance?.barrels?.status==='provisional';
}
export function reportedTrackingBottom(packet:any,topInches:number):number|null {
 const bottom=Number(packet?.watchdogProvenance?.reportedBottomFeet)*12;
 return isProvisionalPull(packet)&&packet?.watchdogProvenance?.reportedBottomFeet!=null&&Number.isFinite(bottom)&&bottom>=0&&bottom<=topInches?bottom:null;
}
