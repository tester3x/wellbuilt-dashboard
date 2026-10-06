import {diagnosticFlowWindow} from '../flowWindows';
import {possibleAggregateOverlap} from './aggregateOverlap';
import {watchdogSenderKey,resolveWatchdogOwner} from './senderOwnership';
import { barrelEstimate } from './barrelEstimate';
import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {verifyHmacHeaders} from './auth';
import {parsePullChat,findPullChatNotices} from '../imports/pullParser';
import {reviewPulls,digest,type JsonRecord} from '../imports/pullImportModel';
const options={region:'us-central1',timeoutSeconds:60,memory:'256MiB' as const,secrets:['WATCHDOG_HMAC_KEY_V1']};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const root='watchdog_v2_deliveries';
async function authenticate(req:any,endpoint:string){
 if(req.method!=='POST')throw Error('method_not_allowed');
 if(req.headers['x-watchdog-key-id']!=='V1')throw Error('unknown_key');
 if(!/^[a-f0-9]{32}$/.test(req.headers['x-watchdog-nonce']||''))throw Error('invalid_nonce');
 const raw=req.rawBody as Buffer;if(!raw||raw.length>12000)throw Error('body_limit');
 const verified=verifyHmacHeaders({endpointName:endpoint,method:'POST',headers:req.headers,rawBody:raw});
 if(!verified.ok)throw Error(verified.error||'authentication_failed');
 const nonce=admin.firestore().collection('watchdog_v2_nonces').doc(req.headers['x-watchdog-nonce']);
 const rate=admin.firestore().doc('watchdog_v2_rates/'+Math.floor(Date.now()/3600000));
 await admin.firestore().runTransaction(async tx=>{const [seen,bucket]=await Promise.all([tx.get(nonce),tx.get(rate)]);if(seen.exists)throw Error('replay_detected');const count=Number(bucket.data()?.count||0);if(count>=10000)throw Error('rate_limit');tx.create(nonce,{createdAt:Date.now()});tx.set(rate,{count:count+1});});
}
export const ingestWatchdogPullV2=https.onRequest(options,async(req,res)=>{
 try{
 await authenticate(req,'ingestWatchdogPullV2');
 const body=req.body as JsonRecord;
 if(!body||Object.keys(body).some(k=>!['chatId','messageId','chat','rowIndex','review','defaultBbls','senderId'].includes(k))||typeof body.chatId!=='string'||typeof body.messageId!=='string'||typeof body.chat!=='string'||body.chat.length>6000||!Number.isInteger(body.rowIndex)||body.rowIndex<0||body.rowIndex>10)throw Error('invalid_observation');
 const policy=(await admin.firestore().doc('watchdog_v2_config/laptop').get()).data();
 if(!policy?.enabled)throw Error('transport_disabled');
 const channel=policy.channels?.[body.chatId];if(!channel)throw Error('channel_not_allowed');
 const fallback=Object.prototype.hasOwnProperty.call(body,'defaultBbls')?body.defaultBbls:channel.defaultBbls;
 if(fallback!=null&&fallback!==0&&(!Number.isFinite(fallback)||fallback<=0||fallback>1000))throw Error('invalid_barrel_fallback');
 const rows=parsePullChat(body.chat,{defaultWell:channel.defaultWell||'',wellNames:channel.wells||[],defaultBbls:fallback>0?fallback:undefined});
 const row=rows[body.rowIndex];if(!row)throw Error('missing_pull');
 const senderKey=body.senderId===undefined?null:watchdogSenderKey(body.senderId);
 const originalTime=row.dateTimeUTC;
 const review=body.review;
 if(review){
   if(Object.keys(review).some(k=>!['dateTimeUTC','reason','confirmed'].includes(k))||review.confirmed!==true||typeof review.reason!=='string'||review.reason.trim().length<3||review.reason.length>300||typeof review.dateTimeUTC!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(review.dateTimeUTC)||!Number.isFinite(Date.parse(review.dateTimeUTC)))throw Error('invalid_review');
   row.dateTimeUTC=review.dateTimeUTC;
 }

 if(Date.parse(row.postedAt)<Math.max(policy.enabledAt,channel.enabledAt||0)||Date.parse(row.dateTimeUTC)<Math.max(policy.enabledAt,channel.enabledAt||0)) {res.json({ok:true,status:'before_activation'});return;}
 if(findPullChatNotices(body.chat).length||row.issues.length) {res.json({ok:true,status:'review',issues:row.issues.length?row.issues:['Tank setup needs review']});return;}
 const db=admin.database();const configs=(await db.ref('well_config').once('value')).val()||{};
 const mapped=reviewPulls([row],configs,{}, {},new Set())[0];
 if(!channel.wells?.includes(mapped.wellName)||configs[mapped.wellName]?.companyId&&configs[mapped.wellName].companyId!=='liquid-gold')throw Error('well_not_allowed');
 if(policy.archivedWells?.[mapped.wellName]){res.json({ok:true,status:'archived',issues:['Monitoring ended for this well']});return;}
 const binding=senderKey?policy.senderBindings?.[senderKey]:null;
 if(binding&&(typeof binding.driverId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(binding.driverId)))throw Error('sender_binding_invalid');
 const profile=binding?(await db.ref('drivers/profiles/'+binding.driverId).once('value')).val():null;
 const owner=resolveWatchdogOwner(binding,profile,mapped.wellName,configs[mapped.wellName]);
 const [processed,incoming]=await Promise.all([db.ref('packets/processed').orderByChild('wellName').equalTo(mapped.wellName).once('value'),db.ref('packets/incoming').orderByChild('wellName').equalTo(mapped.wellName).once('value')]);
 const history={[mapped.wellName]:{...(processed.val()||{}),...(incoming.val()||{})}};
 const checked=reviewPulls([row],configs,history,{},new Set())[0];
 if(configs[mapped.wellName].flowWindowMinimumRecoveryInches && row.bottomLevelFeet!==null){
   const reported=row.bottomLevelFeet;
   if(!Number.isFinite(reported)||reported<0||reported>Number(row.tankLevelFeet)||Math.abs(reported-Number(checked.afterFeet))*12>2){res.json({ok:true,status:'review',issues:['Reported bottom differs from calibrated removal by more than two inches; confirm levels and barrels']});return;}
   checked.afterFeet=reported;
 }
 let estimate: ReturnType<typeof barrelEstimate> = null;
 let barrelSource: 'written' | 'default' = 'written';
 if(/^Gunslinger (3|5)$/.test(mapped.wellName)) {
   const noDefault=parsePullChat(body.chat,{defaultWell:channel.defaultWell||'',wellNames:channel.wells||[]})[body.rowIndex];
   barrelSource=noDefault?.bblsTaken == null ? 'default' : 'written';
   const status=(await db.ref('wells/'+mapped.wellName+'/status').once('value')).val();
   estimate=barrelEstimate({top:row.tankLevelFeet,bottom:row.bottomLevelFeet,bank:checked.bank,rateMinutesPerFoot:Number(status?.calculated?.flowRateMinutes),isDown:status?.isDown!==false,rateMeasuredAt:status?.lastPull?.dateTimeUTC||'',measuredAt:row.dateTimeUTC});
 }

 if(review&&checked.status==='review'){
   checked.issues=checked.issues.filter(issue=>issue!=='Possible existing pull within 30 minutes; check time and barrels, then confirm or exclude');
   if(!checked.issues.length)checked.status='ready';
 }

 const aggregateMatches=possibleAggregateOverlap({...row,wellName:mapped.wellName},history[mapped.wellName],owner?.driverId??null);
 if(aggregateMatches.length){res.json({ok:true,status:'review',issues:['Possible load already included in a combined manual pull; reconcile the combined entry before sending'],aggregatePacketIds:aggregateMatches,estimate,barrelSource});return;}
 const identity=digest([mapped.wellName,row.dateTimeUTC,row.tankLevelFeet,row.bottomLevelFeet,row.bblsTaken]);
 const entryRef=admin.firestore().collection(root).doc(identity);
 const prior=(await entryRef.get()).data();
 if(!prior&&checked.status!=='ready'){res.json({ok:true,status:checked.status,issues:checked.issues,estimate,barrelSource});return;}
 if(prior){res.json({ok:true,status:'queued',identity,packetId:prior.packetId,estimate:prior.estimate,barrelSource:prior.barrelSource});return;}
 const stamp=new Date(row.dateTimeUTC).toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','_');
 const packetId=stamp+'_'+mapped.wellName.replace(/\s+/g,'')+'_'+identity.slice(0,6);
 const packet={packetId,idempotencyKey:packetId,requestType:'pull',wellName:mapped.wellName,tankLevelFeet:row.tankLevelFeet,bottomLevelFeet:checked.afterFeet,bblsTaken:row.bblsTaken,dateTimeUTC:row.dateTimeUTC,timezone:'America/Chicago',companyId:'liquid-gold',source:'whatsapp_watchdog',driverId:owner?.driverId??null,driverName:owner?.driverName??null,wellDownIsAuthoritative:false,watchdogProvenance:{principalId:'laptop-watchdog-v2',observationDigest:identity,...(owner?{senderKey,ownerDriverId:owner.driverId,ownershipSource:'verified_sender_binding'}:{}),reportedBottomFeet:row.bottomLevelFeet,bblPerFoot:checked.bank,...(estimate?{barrelEstimate:estimate,barrelSource}:{}),...(review?{review:{originalTime,correctedTime:row.dateTimeUTC,reason:review.reason.trim(),confirmedAt:new Date().toISOString()}}:{})}};
 const flowDiagnostic=diagnosticFlowWindow(history[mapped.wellName],{...packet,tankTopInches:Number(row.tankLevelFeet)*12,tankAfterInches:Number(checked.afterFeet)*12},6);
 Object.assign(packet.watchdogProvenance,{flowDiagnostic:{...flowDiagnostic,mode:'shadow',minimumRecoveryInches:6}});
 const payloadDigest=digest(packet);
 await admin.firestore().runTransaction(async tx=>{const previous=await tx.get(entryRef);if(previous.exists){if(previous.data()?.payloadDigest!==payloadDigest)throw Error('payload_conflict');return;}tx.create(entryRef,{identity,packetId,payloadDigest,wellName:mapped.wellName,dateTimeUTC:row.dateTimeUTC,top:row.tankLevelFeet,bottom:checked.afterFeet,bbl:row.bblsTaken,principalId:'laptop-watchdog-v2',flowDiagnostic,messageHash:sha(body.chatId+':'+body.messageId),estimate,barrelSource,createdAt:Date.now()});});
 const done=await db.ref('packets/processed/'+packetId).once('value');
 if(!done.exists()){const transaction=await db.ref('packets/incoming/'+packetId).transaction(current=>{if(current){if(digest(current)!==payloadDigest)return;return current;}return packet;});if(!transaction.committed)throw Error('incoming_conflict');}
 res.json({ok:true,status:'queued',identity,packetId,estimate,barrelSource,flowDiagnostic});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message)});}
});
export const getWatchdogPullReceiptV2=https.onRequest(options,async(req,res)=>{
 try{await authenticate(req,'getWatchdogPullReceiptV2');const identity=req.body?.identity;if(typeof identity!=='string'||!/^[a-f0-9]{64}$/.test(identity)||Object.keys(req.body).some(k=>k!=='identity'))throw Error('invalid_receipt');
 const entry=(await admin.firestore().collection(root).doc(identity).get()).data();if(!entry||entry.principalId!=='laptop-watchdog-v2')throw Error('receipt_not_owned');
 const db=admin.database();const packet=(await db.ref('packets/processed/'+entry.packetId).once('value')).val();
 // The canonical processor can use a different tank calibration than intake.
 // Its completion snapshot binds the receipt to the result actually committed.
 const snapshotBottom=packet?.canonicalProcessingBottomInches;
 const hasSnapshot=typeof snapshotBottom==='number'&&Number.isFinite(snapshotBottom);
 const expectedBottom=hasSnapshot?snapshotBottom:entry.bottom*12;
 const snapshotOwned=!hasSnapshot||(packet.watchdogProvenance?.observationDigest===identity&&packet.watchdogProvenance?.principalId===entry.principalId);
 const matched=packet&&snapshotOwned&&packet.wellName===entry.wellName&&packet.dateTimeUTC===entry.dateTimeUTC&&Number(packet.tankLevelFeet)===entry.top&&Number(packet.bblsTaken)===entry.bbl&&Math.abs(Number(packet.tankAfterInches)-expectedBottom)<0.01;
 res.json({ok:true,identity,packetId:entry.packetId,estimate:entry.estimate,barrelSource:entry.barrelSource,status:matched&&packet.canonicalProcessingComplete===true?'complete':packet?'incomplete':'queued'});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message)});}
});

export const getWatchdogWellLifecycleV2=https.onRequest(options,async(req,res)=>{
 try{await authenticate(req,'getWatchdogWellLifecycleV2');if(Object.keys(req.body||{}).length)throw Error('invalid_request');
 const policy=(await admin.firestore().doc('watchdog_v2_config/laptop').get()).data();if(!policy?.enabled)throw Error('transport_disabled');
 const names=[...new Set<string>(Object.values(policy.channels||{}).flatMap((c:any)=>c.wells||[]))];
 const wells=await Promise.all(names.map(async wellName=>{const archive=policy.archivedWells?.[wellName]||null;let confirmed=false;if(archive){const db=admin.database();const [done,down]=await Promise.all([db.ref('packets/processed/'+archive.packetId).once('value'),db.ref('wells/'+wellName+'/status/isDown').once('value')]);confirmed=done.val()?.noLevel===true&&down.val()===true;}return {wellName,channels:Object.entries(policy.channels||{}).filter(([,c]:any)=>c.wells?.includes(wellName)).map(([id])=>id),archive,state:archive?(confirmed?'archived':'stopping'):'watching'};}));res.json({ok:true,wells});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message)});}
});
export const stopWatchdogWellV2=https.onRequest(options,async(req,res)=>{
 try{await authenticate(req,'stopWatchdogWellV2');const {wellName,reason}=req.body||{};
 if(Object.keys(req.body||{}).some(k=>!['wellName','reason'].includes(k))||typeof wellName!=='string'||/[.#$\[\]\/]/.test(wellName)||typeof reason!=='string'||reason.trim().length<3||reason.length>300)throw Error('invalid_stop');
 const ref=admin.firestore().doc('watchdog_v2_config/laptop');const db=admin.database();const config=(await db.ref('well_config/'+wellName).once('value')).val();
 if(!config||(config.companyId&&config.companyId!=='liquid-gold'))throw Error('well_not_allowed');
 const archive=await admin.firestore().runTransaction(async tx=>{const policy=(await tx.get(ref)).data();if(!policy?.enabled||!Object.values(policy.channels||{}).some((c:any)=>c.wells?.includes(wellName)))throw Error('well_not_allowed');if(policy.archivedWells?.[wellName])return policy.archivedWells[wellName];
 const at=new Date().toISOString();const packetId='watchdog_stop_'+sha(wellName+':'+at).slice(0,24);const value={packetId,at,reason:reason.trim(),principalId:'laptop-watchdog-v2'};tx.set(ref,{...policy,archivedWells:{...(policy.archivedWells||{}),[wellName]:value}});return value;});
 const packet={packetId:archive.packetId,idempotencyKey:archive.packetId,requestType:'pull',wellName,tankLevelFeet:0,bblsTaken:0,dateTimeUTC:archive.at,timezone:'America/Chicago',companyId:'liquid-gold',wellDown:true,wellDownIsAuthoritative:true,source:'whatsapp_watchdog_stop',watchdogProvenance:{principalId:'laptop-watchdog-v2',reason:archive.reason,lifecycle:'archive'}};
 const done=await db.ref('packets/processed/'+archive.packetId).once('value');if(!done.exists()){const write=await db.ref('packets/incoming/'+archive.packetId).transaction(current=>current||packet);if(!write.committed)throw Error('stop_queue_failed');}
 if(!archive.confirmedAt){await Promise.all([db.ref('wells/'+wellName+'/status/isDown').set(packet.wellDown),db.ref('well_config/'+wellName+'/isDown').set(packet.wellDown)]);await admin.firestore().runTransaction(async tx=>{const policy=(await tx.get(ref)).data();const existing=policy?.archivedWells?.[wellName];if(existing?.packetId!==archive.packetId)throw Error('archive_changed');tx.set(ref,{...policy,archivedWells:{...policy?.archivedWells,[wellName]:{...existing,confirmedAt:new Date().toISOString()}}});});}
 // Publish the same outgoing snapshot WB M subscribes to; status flags alone do not refresh its cache.
 const latestPolicy=(await ref.get()).data();const saved=latestPolicy?.archivedWells?.[wellName];
 if(!saved?.responsePublishedAt&&(await db.ref('wells/'+wellName+'/status/isDown').once('value')).val()===true){
  const outgoing=(await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
  const entries=Object.entries(outgoing) as [string,any][];
  if(!entries.length)throw Error('stop_response_missing');
  const publishedAt=new Date().toISOString();
  for(const [id,previous] of entries){await db.ref('packets/outgoing/'+id).set({...previous,wellDown:true,currentLevel:'Down',timeTillPull:'Down',nextPullTime:'Down',nextPullTimeUTC:'',timestamp:publishedAt,timestampUTC:publishedAt,watchdogStopPacketId:archive.packetId});}
  await admin.firestore().runTransaction(async tx=>{const current=(await tx.get(ref)).data();const item=current?.archivedWells?.[wellName];if(item?.packetId!==archive.packetId)throw Error('archive_changed');tx.set(ref,{...current,archivedWells:{...current?.archivedWells,[wellName]:{...item,responsePublishedAt:publishedAt}}});});
 }
 res.json({ok:true,state:'stopping',archive});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message)});}
});
