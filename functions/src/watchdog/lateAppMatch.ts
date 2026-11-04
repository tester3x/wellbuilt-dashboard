import {calibration,canonicalHistory,digest,type JsonRecord} from '../imports/pullImportModel';
import {matchExistingAppPull} from './existingAppPull';
import {resolveWatchdogOwner} from './senderOwnership';

const principal='laptop-watchdog-v2';
// Deleting the duplicate legitimately recalculates the next app packet's flow
// fields. Bind the kept measurement, not those derived recovery calculations.
export function appMatchFingerprint(p:any):string {
 return digest(p ? [p.packetId??null,p.companyId,p.wellName,p.driverId,p.dateTimeUTC,p.tankLevelFeet,p.tankTopInches??null,
  p.tankAfterInches??null,p.bottomLevelFeet??null,p.bblsTaken,p.source??null,p.originAppContext??null,p.requestType||'pull',p.editCount??0,p.canonicalProcessingComplete,p.deleted===true] : null);
}
export function ownedWatchdogPacket(p:any):boolean {
 return p?.source==='whatsapp_watchdog' && p.companyId==='liquid-gold' &&
  p.watchdogProvenance?.principalId===principal && /^[a-f0-9]{64}$/.test(p.watchdogProvenance?.observationDigest||'') &&
  typeof p.driverId==='string' && !!p.driverId && p.canonicalProcessingComplete===true && !p.deleted && !p.historicalOnly;
}
export function completedMatchRecord(p:any):boolean {
 return p && (p.requestType||'pull')==='pull' && p.companyId==='liquid-gold' && p.canonicalProcessingComplete===true &&
  !p.deleted && !p.historicalOnly && Number.isFinite(p.tankLevelFeet) && Number.isFinite(p.bblsTaken);
}
export function matchLateAppPacket(packetId:string,history:JsonRecord,bank:number){
 const p=history[packetId];
 if(!ownedWatchdogPacket(p)||!completedMatchRecord(p))return {status:'none' as const,packetIds:[]};
 const proof=p.watchdogProvenance;
 const levelOnly=proof.observationKind==='top_only' && p.bblsTaken===0;
 if(p.bblsTaken===0&&!levelOnly)return {status:'none' as const,packetIds:[]};
 const explicit=proof.barrelSource==='written';
 // A manual correction is independent evidence; do not silently replace it with
 // an old parsed estimate or ignore its confirmed barrel amount.
 if(proof.review || Number(p.editCount)>0)return {status:'review' as const,packetIds:[]};
 const tree=Object.fromEntries(Object.entries(history).filter(([key])=>key!==packetId).map(([key,row])=>[key,{...row,watchdogProcessed:row.canonicalProcessingComplete===true}]));
 return matchExistingAppPull({packetId,wellName:p.wellName,dateTimeUTC:p.dateTimeUTC,tankLevelFeet:p.tankLevelFeet,
  bottomLevelFeet:proof.reportedBottomFeet??null,bblsTaken:p.bblsTaken,levelOnly},tree,p.driverId,bank,explicit||levelOnly);
}

export interface LateMatchDeps {
 read(path:string):Promise<any>;
 history(well:string):Promise<JsonRecord>;
 policy():Promise<any>;
 entry(identity:string):Promise<any>;
 audit(id:string,value:any):Promise<any>;
 enqueue(id:string,value:any):Promise<void>;
 now():number;
}
/** Queue the existing canonical delete processor, retaining the entire original
 * in a separate audit collection. Never mutate an app packet, invoice or ticket.
 * A deterministic delete event and audit make repeated trigger delivery safe.
 */
export async function reconcileLateAppMatches(well:string,triggerId:string,deps:LateMatchDeps,operator?:{actorUid:string;reason:string;packetIds:string[]}){
 const policy=await deps.policy();
 if(!policy?.enabled||!Object.values(policy.channels||{}).some((c:any)=>c.wells?.includes(well)))return [];
 const history=await deps.history(well),trigger=history[triggerId];
 if(!completedMatchRecord(trigger)||trigger.wellName!==well)return [];
 const config=await deps.read('well_config/'+well),bank=config?calibration(config):0;
 if(!(bank>0))return [];
 const results:any[]=[];
 for(const p of canonicalHistory(history)){
  const id=p.key;
  if(!ownedWatchdogPacket(p) || (operator&&!operator.packetIds.includes(id)))continue;
  if(Math.abs(Date.parse(p.dateTimeUTC)-Date.parse(trigger.dateTimeUTC))>90*60000)continue;
  const proof=p.watchdogProvenance;
  // The verified sender must still own this driver. No name/phone heuristics.
  const binding=Object.values(policy.senderBindings||{}).find((b:any)=>b.enabled===true&&b.companyId==='liquid-gold'&&b.driverId===p.driverId);
  if(!binding)continue;
  try {if(!resolveWatchdogOwner(binding,await deps.read('drivers/profiles/'+p.driverId),well,config))continue;}catch{continue;}
  const identity=proof.observationDigest,entry=await deps.entry(identity);
  if(!entry||entry.principalId!==principal||entry.packetId!==id||entry.pendingReview||entry.rejectedResolution)continue;
  let match=matchLateAppPacket(id,history,bank);
  if(operator){
   // Owner-confirmed cleanup may include a previously reviewed estimate. The
   // same strict app/owner/level/ambiguity checks still apply.
   const raw={...p,watchdogProvenance:{...proof,review:undefined},editCount:0};
   match=matchLateAppPacket(id,{...history,[id]:raw},bank);
  }
  if(match.status!=='matched')continue;
  const keptId=match.packetIds[0],kept=history[keptId];
  if(!kept||kept.companyId!=='liquid-gold')continue;
  // Verify the immutable evidence immediately before publishing a command.
  const [live,app]=await Promise.all([deps.read('packets/processed/'+id),deps.read('packets/processed/'+keptId)]);
  if(digest(live)!==digest(history[id])||digest(app)!==digest(kept))continue;
  const eventId='watchdog_app_match_'+digest([id,keptId]).slice(0,32);
  const record={companyId:'liquid-gold',wellName:well,identity,packetId:id,keptPacketId:keptId,
   packetDigest:digest(live),keptDigest:appMatchFingerprint(app),originalPacket:live,keptMeasurement:{dateTimeUTC:app.dateTimeUTC,tankLevelFeet:app.tankLevelFeet,bblsTaken:app.bblsTaken},
   actorUid:operator?.actorUid||'system:watchdog-late-app-match',reason:operator?.reason||'Same verified driver, well and gauge matched one completed app record; preserve app record and remove duplicate WhatsApp history.',
   eventId,requestedAt:deps.now()};
  const saved=await deps.audit(eventId,record);
  if(saved.packetDigest!==record.packetDigest||saved.keptDigest!==record.keptDigest)throw Error('Late app match audit conflict');
  await deps.enqueue(eventId,{requestType:'delete',packetId:id,originalPacketId:id,wellName:well,companyId:'liquid-gold',source:'watchdog_app_match',
   reason:record.reason,actorUid:record.actorUid,watchdogSupersession:{eventId,identity,keptPacketId:keptId,packetDigest:record.packetDigest,keptDigest:record.keptDigest}});
  results.push({packetId:id,keptPacketId:keptId,eventId});
 }
 return results;
}
