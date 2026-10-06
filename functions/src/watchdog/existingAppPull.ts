import {canonicalHistory,type JsonRecord} from '../imports/pullImportModel';
/** A later chat report may describe the app pull already published at Depart.
 * Time alone never suppresses a load. Missing ownership/levels or conflicting
 * candidates remain reviewable. The 90-minute ceiling includes loading and paperwork.
 */
export function matchExistingAppPull(row:any,history:JsonRecord,driverId:string|null,bank:number){
 const time=Date.parse(row.dateTimeUTC);const all=canonicalHistory(history);
 const candidates=all.filter(p=>p.wellName===row.wellName && !String(p.source||'').startsWith('whatsapp_watchdog') && p.requestType==='pull' &&
   time-Date.parse(p.dateTimeUTC)>=0 && time-Date.parse(p.dateTimeUTC)<=90*60000 &&
   Math.abs(Number(p.tankLevelFeet)-row.tankLevelFeet)<=1/12+1e-8);
 if(!candidates.length)return {status:'none' as const,packetIds:[]};
 const ids=candidates.map(p=>String(p.packetId||p.key));
 if(candidates.length!==1)return {status:'review' as const,packetIds:ids};
 const p=candidates[0];const bottom=Number.isFinite(p.tankAfterInches)?p.tankAfterInches/12:
   Number.isFinite(p.bottomLevelFeet)?p.bottomLevelFeet:Number(p.tankLevelFeet)-Number(p.bblsTaken)/bank;
 const intervening=all.some(q=>q!==p&&Date.parse(q.dateTimeUTC)>Date.parse(p.dateTimeUTC)&&Date.parse(q.dateTimeUTC)<=time);
 const strong=p.watchdogProcessed===true && p.canonicalProcessingComplete===true && driverId && p.driverId===driverId && Number(p.bblsTaken)===row.bblsTaken &&
   typeof row.bottomLevelFeet==='number' && Number.isFinite(bottom) && Math.abs(bottom-row.bottomLevelFeet)<=2/12+1e-8 && !intervening;
 return strong?{status:'matched' as const,packetIds:ids,dateTimeUTC:p.dateTimeUTC}:
   {status:'review' as const,packetIds:ids};
}
