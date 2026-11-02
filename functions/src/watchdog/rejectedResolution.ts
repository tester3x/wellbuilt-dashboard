import * as admin from 'firebase-admin';
import {buildHistoricalPackets, calibration, canonicalHistory, digest, reviewPulls} from '../imports/pullImportModel';

const principal='laptop-watchdog-v2';
export function historicalResolutionReceipt(entry:any, packet:any, identity:string):any|null {
  const resolution=entry?.rejectedResolution;
  if(!resolution || resolution.identity!==identity || resolution.packetId!==entry.packetId || !resolution.actorUid || !resolution.reason)return null;
  if(resolution.status==='excluded')return {ok:true,identity,packetId:entry.packetId,status:'excluded',needsReview:false,issues:[]};
  if(resolution.status!=='complete' || !packet?.historicalOnly || packet.watchdogHistoricalResolution?.id!==resolution.id ||
    packet.watchdogProvenance?.observationDigest!==identity || packet.watchdogProvenance?.principalId!==principal ||
    packet.wellName!==entry.wellName || packet.dateTimeUTC!==entry.dateTimeUTC || packet.tankLevelFeet!==entry.top || packet.bblsTaken!==entry.bbl ||
    !Number.isFinite(packet.tankAfterInches))return null;
  return {ok:true,identity,packetId:entry.packetId,status:'complete',historicalOnly:true,needsReview:false,issues:[],
    measurements:{tankLevelFeet:entry.top,bottomLevelFeet:entry.reportedBottomFeet??entry.bottom,bblsTaken:entry.bbl,dateTimeUTC:entry.dateTimeUTC}};
}

// Called only after dashboard authorization, or by authenticated operator tooling.
// It never moves a well's current gauge, lastPull, outgoing view or invoice.
export async function resolveRejectedReview(input:{companyId:string;id:string;revision:string;decision:string;reason:string},actorUid:string){
  if(input.companyId!=='liquid-gold'||!actorUid||!/^[a-f0-9]{64}$/.test(input.id)||!/^[a-f0-9]{64}$/.test(input.revision)||
    !['record_history','exclude'].includes(input.decision)||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>300)throw Error('Invalid reconciliation request');
  const fs=admin.firestore(),db=admin.database();
  const itemRef=fs.doc('watchdog_review_inbox/'+input.companyId+'/items/'+input.id);
  const item=(await itemRef.get()).data();
  if(!item||item.companyId!==input.companyId)throw Error('Review not in this company');
  if(item.recoveryResult){if(item.recoveryDecision!==input.decision)throw Error('Review already resolved differently');return item.recoveryResult;}
  if(item.status!=='review'||item.revision!==input.revision||item.command?.state==='pending')throw Error('Review changed; refresh');
  const row=item.row;
  // Receipts display the calibrated bottom when a reviewer discarded the reported
  // bottom. Its observation identity still binds the original null value.
  const identities=[...new Set([row.bottomLevelFeet,null].map(bottom=>digest([row.wellName,row.dateTimeUTC,row.tankLevelFeet,bottom,row.bblsTaken])))];
  const candidates=await Promise.all(identities.map(async identity=>{
    const entryRef=fs.doc('watchdog_v2_deliveries/'+identity),entry=(await entryRef.get()).data();
    return {identity,entryRef,entry};
  }));
  const matches=candidates.filter(({entry})=>entry && (entry.reportedBottomFeet===row.bottomLevelFeet || entry.reportedBottomFeet===null&&entry.bottom===row.bottomLevelFeet));
  if(matches.length!==1)throw Error('Observation ownership changed');
  const {identity,entryRef,entry}=matches[0];
  const policy=(await fs.doc('watchdog_v2_config/laptop').get()).data();
  if(!policy?.enabled||!policy.channels?.[item.channel]?.wells?.includes(row.wellName)||!entry||entry.identity!==identity||entry.principalId!==principal||
    entry.wellName!==row.wellName||entry.dateTimeUTC!==row.dateTimeUTC||entry.top!==row.tankLevelFeet||entry.bbl!==row.bblsTaken||entry.pendingReview)throw Error('Observation ownership changed');
  const rejected=(await db.ref('packets/rejected/'+entry.packetId).once('value')).val();
  const original=rejected?.packet;
  if(rejected?.packetId!==entry.packetId||original?.watchdogProvenance?.observationDigest!==identity||original?.watchdogProvenance?.principalId!==principal||
    original.wellName!==entry.wellName||original.dateTimeUTC!==entry.dateTimeUTC||original.tankLevelFeet!==entry.top||original.bblsTaken!==entry.bbl)throw Error('Owned processor rejection required');
  if(input.decision==='record_history'&&rejected.reason!=='STALE_PULL_TIME')throw Error('Only stale-time rejections can be recorded as history');
  const operationId=digest(['watchdog-rejected-resolution',identity,input.decision]);
  const existing=(await db.ref('packets/processed/'+entry.packetId).once('value')).val();
  if(existing&&existing.watchdogHistoricalResolution?.id!==operationId)throw Error('This load is already recorded; refresh before reconciling');
  const auditRef=fs.doc('watchdog_review_audit/'+operationId);
  const resolution={id:operationId,identity,packetId:entry.packetId,actorUid,reason:input.reason.trim(),status:input.decision==='record_history'?'complete':'excluded',at:Date.now()};
  await fs.runTransaction(async tx=>{
    const live=(await tx.get(itemRef)).data(),audit=(await tx.get(auditRef)).data();
    if(live?.revision!==input.revision||live.command?.state==='pending'||live.resolutionPending&&live.resolutionPending!==operationId)throw Error('Review changed; refresh');
    if(audit&&(audit.decision!==input.decision||audit.actorUid!==actorUid))throw Error('Resolution conflict');
    tx.set(auditRef,{...audit,companyId:input.companyId,rowId:item.rowId,identity,packetId:entry.packetId,actorUid,reason:resolution.reason,decision:input.decision,state:'applying',requestedAt:audit?.requestedAt||Date.now()});
    tx.update(itemRef,{resolutionPending:operationId});
  });
  try {
  if(input.decision==='record_history'){
    const config=(await db.ref('well_config/'+row.wellName).once('value')).val();
    const bank=config?calibration(config):0;
    if(!config||!Number.isFinite(bank)||bank<=0)throw Error('Valid tank calibration required');
    const history=(await db.ref('packets/processed').orderByChild('wellName').equalTo(row.wellName).once('value')).val()||{};
    const reviewed=reviewPulls([{...row,issues:[],excluded:false}],{[row.wellName]:config},{[row.wellName]:history},{[row.wellName]:bank},new Set())[0];
    if(reviewed.status==='duplicate'&&!history[entry.packetId])throw Error('Equivalent load already exists; reconcile its existing record instead');
    if(reviewed.status!=='ready'&&!history[entry.packetId])throw Error(reviewed.issues.join('; ')||'Load is not ready for historical recording');
    const latest=canonicalHistory(history).slice(-1)[0];
    if(!latest||Date.parse(latest.dateTimeUTC)<=Date.parse(row.dateTimeUTC))throw Error('A newer completed load is required for historical recovery');
    const historical=Object.values(buildHistoricalPackets([{...reviewed,status:'ready',packetId:entry.packetId}],{[row.wellName]:history},operationId,actorUid,input.companyId))[0];
    const packet={...original,...historical,companyId:input.companyId,watchdogHistoricalResolution:{id:operationId,identity,actorUid,reason:resolution.reason,at:resolution.at}};
    const result=await db.ref('packets/processed/'+entry.packetId).transaction(current=>current?undefined:packet);
    const saved=result.snapshot.val();
    if(saved?.watchdogHistoricalResolution?.id!==operationId||saved.watchdogProvenance?.observationDigest!==identity||saved.dateTimeUTC!==row.dateTimeUTC||saved.bblsTaken!==row.bblsTaken)throw Error('Historical packet conflict');
  }
  const packet=(await db.ref('packets/processed/'+entry.packetId).once('value')).val();
  const receipt=historicalResolutionReceipt({...entry,rejectedResolution:resolution},packet,identity);
  if(!receipt)throw Error('Historical confirmation incomplete');
  await fs.runTransaction(async tx=>{
    const live=(await tx.get(itemRef)).data(),current=(await tx.get(entryRef)).data();
    if(live?.resolutionPending!==operationId||current?.pendingReview)throw Error('Resolution changed');
    tx.update(entryRef,{rejectedResolution:resolution});
    tx.update(itemRef,{status:receipt.status,editable:false,issues:[],resolutionPending:null,recoveryResult:receipt,recoveryDecision:input.decision,resolvedAt:Date.now()});
    tx.update(auditRef,{state:'complete',completedAt:Date.now(),receipt});
  });
  return receipt;
  } catch(error) {
    await fs.runTransaction(async tx=>{
      const current=(await tx.get(itemRef)).data();
      if(current?.resolutionPending===operationId&&!current.recoveryResult){
        tx.update(itemRef,{resolutionPending:null});
        tx.update(auditRef,{state:'failed',error:String((error as Error).message).slice(0,300),failedAt:Date.now()});
      }
    });
    throw error;
  }
}
