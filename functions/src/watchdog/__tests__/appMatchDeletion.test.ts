const docs=new Map<string,any>(),rows=new Map<string,any>();
const doc=(key:string)=>({key,get:async()=>({data:()=>docs.get(key)})});
jest.mock('firebase-admin',()=>({firestore:()=>({doc,runTransaction:async(fn:any)=>fn({get:(ref:any)=>ref.get(),update:(ref:any,v:any)=>docs.set(ref.key,{...docs.get(ref.key),...v})})}),database:()=>({ref:(path:string)=>({once:async()=>({val:()=>rows.get(path)})})})}));
import {validateAppMatchDeletion,finishAppMatchDeletion,lateAppMatchReceipt} from '../appMatchDeletion';
import {digest} from '../../imports/pullImportModel';
import {appMatchFingerprint} from '../lateAppMatch';
const identity='a'.repeat(64),id='event';
const chat={source:'whatsapp_watchdog',companyId:'liquid-gold',driverId:'driver',wellName:'Well',canonicalProcessingComplete:true,watchdogProvenance:{principalId:'laptop-watchdog-v2',observationDigest:identity}};
const app={requestType:'pull',companyId:'liquid-gold',driverId:'driver',wellName:'Well',canonicalProcessingComplete:true,tankLevelFeet:12,bblsTaken:140,dateTimeUTC:'2026-11-01T00:00:00Z'};
const proof={eventId:id,identity,keptPacketId:'app',packetDigest:digest(chat),keptDigest:appMatchFingerprint(app)};
const command={source:'watchdog_app_match',packetId:'chat',wellName:'Well',watchdogSupersession:proof};
beforeEach(()=>{docs.clear();rows.clear();docs.set('watchdog_app_match_audit/'+id,{...proof,packetId:'chat',wellName:'Well',originalPacket:chat});docs.set('watchdog_v2_deliveries/'+identity,{packetId:'chat'});rows.set('packets/processed/app',app);});
test('ordinary deletes are unchanged; owned duplicate requires both exact snapshots',async()=>{
 await expect(validateAppMatchDeletion({},null)).resolves.toBeUndefined();
 await expect(validateAppMatchDeletion(command,chat)).resolves.toBeUndefined();
 await expect(validateAppMatchDeletion(command,{...chat,bblsTaken:160})).rejects.toThrow('Watchdog record changed');
 rows.set('packets/processed/app',{...app,bblsTaken:170});await expect(validateAppMatchDeletion(command,chat)).rejects.toThrow('Kept app record changed');
});
test('missing audit, foreign driver and forged commands never remove anything',async()=>{
 await expect(validateAppMatchDeletion({...command,source:'other'},chat)).rejects.toThrow('Unowned');
 docs.delete('watchdog_app_match_audit/'+id);await expect(validateAppMatchDeletion(command,chat)).rejects.toThrow('Unowned');
});
test('completion preserves original receipt and binds duplicate receipt to kept app packet',async()=>{
 rows.set('packets/processed/app',{...app,flowRateDays:0.25,recoveryInches:12,timeDifDays:1});
 await finishAppMatchDeletion(command);await finishAppMatchDeletion(command);
 const entry=docs.get('watchdog_v2_deliveries/'+identity);expect(entry.packetId).toBe('chat');
 expect(lateAppMatchReceipt(entry,identity)).toMatchObject({status:'duplicate',alreadyRecorded:true,matchedPacketId:'app',matchedDateTimeUTC:app.dateTimeUTC,needsReview:false});
 expect(docs.get('watchdog_app_match_audit/'+id).state).toBe('complete');expect(lateAppMatchReceipt({},identity)).toBeNull();
});
