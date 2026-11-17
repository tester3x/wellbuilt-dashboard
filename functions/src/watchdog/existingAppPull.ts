import {canonicalHistory,type JsonRecord} from '../imports/pullImportModel';
/** A chat report and app record may arrive in either order.
 * Time alone never suppresses a load. Missing ownership/levels or conflicting
 * candidates remain reviewable. The 90-minute ceiling includes loading and paperwork.
 */
export function matchExistingAppPull(row:any,history:JsonRecord,driverId:string|null,bank:number,barrelsExplicit=true){
 const time=Date.parse(row.dateTimeUTC);const all=canonicalHistory(history);
 const candidates=all.filter(p=>p.wellName===row.wellName && !String(p.source||'').startsWith('whatsapp_watchdog') && (p.requestType||'pull')==='pull' &&
   Math.abs(time-Date.parse(p.dateTimeUTC))<=90*60000 &&
   (row.levelOnly===true ? Number(p.bblsTaken)===0 : Number(p.bblsTaken)>0) &&
   Math.abs(Number(p.tankLevelFeet)-row.tankLevelFeet)<=1/12+1e-8);
 if(!candidates.length)return {status:'none' as const,packetIds:[]};
 const ids=candidates.map(p=>String(p.packetId||p.key));
 if(candidates.length!==1)return {status:'review' as const,packetIds:ids};
 const p=candidates[0];const bottom=Number.isFinite(p.tankAfterInches)?p.tankAfterInches/12:
   Number.isFinite(p.bottomLevelFeet)?p.bottomLevelFeet:Number(p.tankLevelFeet)-Number(p.bblsTaken)/bank;
 const appTime=Date.parse(p.dateTimeUTC);
 const intervening=all.some(q=>q!==p&&q.key!==row.packetId&&q.packetId!==row.packetId&&q.wellName===row.wellName&&Date.parse(q.dateTimeUTC)>Math.min(appTime,time)&&Date.parse(q.dateTimeUTC)<=Math.max(appTime,time));
 // WB T supplies the measured top; its processing bottom is model-derived.
 // Do not treat that calculated value as an independent driver measurement.
 const modeledWbtBottom=p.bottomLevelFeet==null && (p.originAppContext==='wbt' || (Number.isFinite(p.canonicalProcessingBottomInches) && p.canonicalProcessingBottomInches===p.tankAfterInches));
 const bottomMatches=row.levelOnly===true ? Number(p.bblsTaken)===0 && Number.isFinite(bottom) && Math.abs(bottom-row.tankLevelFeet)<=1/12+1e-8 :
   modeledWbtBottom || (typeof row.bottomLevelFeet==='number' && Number.isFinite(bottom) && Math.abs(bottom-row.bottomLevelFeet)<=2/12+1e-8);
 const strong=p.watchdogProcessed===true && p.canonicalProcessingComplete===true && driverId && p.driverId===driverId && (!barrelsExplicit||Number(p.bblsTaken)===row.bblsTaken) &&
   bottomMatches && !intervening;
 return strong?{status:'matched' as const,packetIds:ids,dateTimeUTC:p.dateTimeUTC}:
   {status:'review' as const,packetIds:ids};
}
