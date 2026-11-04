import * as admin from 'firebase-admin';
import {digest} from '../imports/pullImportModel';
import {appMatchFingerprint,completedMatchRecord,ownedWatchdogPacket} from './lateAppMatch';

export async function validateAppMatchDeletion(command:any,packet:any){
 const proof=command.watchdogSupersession;
 if(!proof)return;
 const audit=(await admin.firestore().doc('watchdog_app_match_audit/'+proof.eventId).get()).data();
 if(command.source!=='watchdog_app_match'||!audit||audit.packetId!==command.packetId||audit.keptPacketId!==proof.keptPacketId||audit.identity!==proof.identity||audit.wellName!==command.wellName||audit.packetDigest!==proof.packetDigest||audit.keptDigest!==proof.keptDigest)throw Error('Unowned Watchdog duplicate deletion');
 const app=(await admin.database().ref('packets/processed/'+proof.keptPacketId).once('value')).val();
 if(!completedMatchRecord(app)||app.source==='whatsapp_watchdog'||app.driverId!==audit.originalPacket.driverId||app.wellName!==command.wellName||appMatchFingerprint(app)!==audit.keptDigest)throw Error('Kept app record changed; duplicate left intact');
 if(packet&&(!ownedWatchdogPacket(packet)||digest(packet)!==audit.packetDigest))throw Error('Watchdog record changed; duplicate left intact');
}
export async function finishAppMatchDeletion(command:any){
 const proof=command.watchdogSupersession;if(!proof)return;
 const fs=admin.firestore(),auditRef=fs.doc('watchdog_app_match_audit/'+proof.eventId),entryRef=fs.doc('watchdog_v2_deliveries/'+proof.identity);
 const app=(await admin.database().ref('packets/processed/'+proof.keptPacketId).once('value')).val();
 await fs.runTransaction(async tx=>{const [a,e]=await Promise.all([tx.get(auditRef),tx.get(entryRef)]);const audit=a.data(),entry=e.data();
  if(!audit||entry?.packetId!==command.packetId||!app||appMatchFingerprint(app)!==audit.keptDigest)throw Error('App match completion changed');
  tx.update(auditRef,{state:'complete',completedAt:Date.now()});
  tx.update(entryRef,{lateAppMatch:{eventId:proof.eventId,matchedPacketId:proof.keptPacketId,matchedDateTimeUTC:app.dateTimeUTC,completedAt:Date.now()}});
 });
}
export function lateAppMatchReceipt(entry:any,identity:string){
 const match=entry?.lateAppMatch;
 return match?.eventId&&match.matchedPacketId&&match.matchedDateTimeUTC ? {ok:true,identity,packetId:entry.packetId,status:'duplicate',alreadyRecorded:true,needsReview:false,
  matchedPacketId:match.matchedPacketId,matchedDateTimeUTC:match.matchedDateTimeUTC,issues:['Already recorded through the app; original app record preserved']} : null;
}
