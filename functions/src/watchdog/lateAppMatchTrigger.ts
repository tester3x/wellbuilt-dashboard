import * as functionsV1 from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import {completedMatchRecord,reconcileLateAppMatches,type LateMatchDeps} from './lateAppMatch';
import {digest} from '../imports/pullImportModel';

export function lateAppMatchDeps():LateMatchDeps {
 const db=admin.database(),fs=admin.firestore();
 return {
  read:async path=>(await db.ref(path).once('value')).val(),
  history:async well=>(await db.ref('packets/processed').orderByChild('wellName').equalTo(well).once('value')).val()||{},
  policy:async()=>(await fs.doc('watchdog_v2_config/laptop').get()).data(),
  entry:async identity=>(await fs.doc('watchdog_v2_deliveries/'+identity).get()).data(),
  audit:async(id,value)=>fs.runTransaction(async tx=>{const ref=fs.doc('watchdog_app_match_audit/'+id),old=(await tx.get(ref)).data();if(old)return old;tx.create(ref,value);return value;}),
  enqueue:async(id,value)=>{const processed=(await db.ref('packets/processed/delete_'+value.packetId).once('value')).val();if(processed?.watchdogSupersession?.eventId===id)return;const result=await db.ref('packets/incoming/'+id).transaction(current=>current||value);if(digest(result.snapshot.val())!==digest(value))throw Error('Late app match command conflict');},
  now:()=>Date.now()
 };
}
export const reconcileWatchdogAppRecords=functionsV1.runWith({timeoutSeconds:120,memory:'256MB',failurePolicy:true}).database
 .ref('packets/processed/{packetId}').onWrite(async(change,context)=>{
  const after=change.after.val(),before=change.before.val();
  if(/^(edit_|delete_|history_)/.test(context.params.packetId)||!completedMatchRecord(after))return null;
  // Ignore bookkeeping writes and the reconciler's own audit/cascade changes.
  const fields=(p:any)=>p?[p.wellName,p.driverId,p.dateTimeUTC,p.tankLevelFeet,p.bblsTaken,p.bottomLevelFeet??null,p.canonicalProcessingComplete,p.editCount??0]:null;
  if(digest(fields(before))===digest(fields(after)))return null;
  await reconcileLateAppMatches(after.wellName,context.params.packetId,lateAppMatchDeps());return null;
 });
