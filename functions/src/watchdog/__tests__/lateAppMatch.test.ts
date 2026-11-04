import {reconcileLateAppMatches,matchLateAppPacket,type LateMatchDeps} from '../lateAppMatch';
import {digest} from '../../imports/pullImportModel';
const identity='a'.repeat(64);
const chat={packetId:'chat',requestType:'pull',companyId:'liquid-gold',source:'whatsapp_watchdog',canonicalProcessingComplete:true,
 wellName:'Well',driverId:'driver-test',dateTimeUTC:'2026-11-01T01:14:00Z',tankLevelFeet:10+10/12,tankAfterInches:46,bblsTaken:142,
 watchdogProvenance:{principalId:'laptop-watchdog-v2',observationDigest:identity,reportedBottomFeet:3+10/12,barrelSource:'estimated'}};
const app={packetId:'app',requestType:'pull',companyId:'liquid-gold',originAppContext:'wbt',canonicalProcessingComplete:true,
 wellName:'Well',driverId:'driver-test',dateTimeUTC:'2026-11-01T01:34:38Z',tankLevelFeet:10+10/12,tankAfterInches:46,bblsTaken:140};
let history:any,audits:Map<string,any>,commands:Map<string,any>,mutateRead=false;
function deps():LateMatchDeps{return {
 read:async path=>path==='well_config/Well'?{bblPerFoot:20,companyId:'liquid-gold'}:path==='drivers/profiles/driver-test'?{active:true,companyId:'liquid-gold',displayName:'Driver',assignedWells:['Well']}:path==='packets/processed/chat'?mutateRead?{...history.chat,bblsTaken:160}:history.chat:path==='packets/processed/app'?history.app:undefined,
 history:async()=>history,policy:async()=>({enabled:true,channels:{group:{wells:['Well']}},senderBindings:{sender:{enabled:true,companyId:'liquid-gold',driverId:'driver-test'}}}),
 entry:async()=>({principalId:'laptop-watchdog-v2',packetId:'chat'}),
 audit:async(id,value)=>{if(!audits.has(id))audits.set(id,value);return audits.get(id);},
 enqueue:async(id,value)=>{if(commands.has(id)&&digest(commands.get(id))!==digest(value))throw Error('conflict');commands.set(id,value);},now:()=>123
};}
beforeEach(()=>{history={chat,app};audits=new Map();commands=new Map();mutateRead=false;});
test('chat-first missing barrels reconciles to later authoritative app amount and time',async()=>{
 const original=JSON.stringify(history);const result=await reconcileLateAppMatches('Well','app',deps());
 expect(result).toHaveLength(1);expect([...commands.values()][0]).toMatchObject({requestType:'delete',packetId:'chat',watchdogSupersession:{keptPacketId:'app'}});
 expect([...audits.values()][0]).toMatchObject({originalPacket:chat,keptMeasurement:{bblsTaken:140,dateTimeUTC:app.dateTimeUTC}});
 expect(JSON.stringify(history)).toBe(original);await reconcileLateAppMatches('Well','app',deps());expect(commands.size).toBe(1);expect(audits.size).toBe(1);
});
test('app-first arriving WhatsApp completion uses the same reconciliation path',async()=>{
 history={chat:{...chat,dateTimeUTC:'2026-11-01T01:50:00Z'},app};
 expect(await reconcileLateAppMatches('Well','chat',deps())).toHaveLength(1);
});
test.each([
 ['different driver',{...app,driverId:'other'}],['incomplete',{...app,canonicalProcessingComplete:false}],
 ['different company',{...app,companyId:'other'}],['unrelated top',{...app,tankLevelFeet:14}],['too late',{...app,dateTimeUTC:'2026-11-01T03:00:00Z'}],
 ['level-only app',{...app,bblsTaken:0,tankAfterInches:130}]
])('%s cannot remove a real load',async(_label,replacement)=>{history.app=replacement;expect(await reconcileLateAppMatches('Well','app',deps())).toHaveLength(0);expect(commands.size).toBe(0);});
test('explicit barrels, ambiguous app matches and intervening pulls prevent automatic deletion',async()=>{
 history.chat={...chat,watchdogProvenance:{...chat.watchdogProvenance,barrelSource:'written'}};
 expect(matchLateAppPacket('chat',history,20).status).toBe('review');history.chat=chat;
 history.second={...app,packetId:'second'};expect(matchLateAppPacket('chat',history,20).status).toBe('review');delete history.second;
 history.between={...app,packetId:'between',dateTimeUTC:'2026-11-01T01:20:00Z',tankLevelFeet:8};expect(matchLateAppPacket('chat',history,20).status).toBe('review');
});
test('manual corrections are preserved unless specifically confirmed by the operator',async()=>{
 history.chat={...chat,watchdogProvenance:{...chat.watchdogProvenance,review:{reason:'previous review'}}};
 expect(await reconcileLateAppMatches('Well','app',deps())).toHaveLength(0);
 expect(await reconcileLateAppMatches('Well','app',deps(),{actorUid:'owner',reason:'Confirmed one physical load',packetIds:['chat']})).toHaveLength(1);
});
test('changed live packet and missing sender binding prevent deletion',async()=>{
 mutateRead=true;expect(await reconcileLateAppMatches('Well','app',deps())).toHaveLength(0);mutateRead=false;
 const d=deps();d.policy=async()=>({enabled:true,channels:{group:{wells:['Well']}}});expect(await reconcileLateAppMatches('Well','app',d)).toHaveLength(0);
});
test('level-only WhatsApp and WB-M observations reconcile without inventing barrels',async()=>{
 history.chat={...chat,bblsTaken:0,watchdogProvenance:{...chat.watchdogProvenance,barrelSource:'written',observationKind:'top_only',reportedBottomFeet:null}};
 history.app={...app,originAppContext:undefined,bblsTaken:0,tankAfterInches:130};
 expect(await reconcileLateAppMatches('Well','app',deps())).toHaveLength(1);
 expect([...audits.values()][0].keptMeasurement.bblsTaken).toBe(0);
});
test('already pending edits or out-of-scope wells cannot be superseded',async()=>{
 const d=deps();d.entry=async()=>({principalId:'laptop-watchdog-v2',packetId:'chat',pendingReview:{}});
 expect(await reconcileLateAppMatches('Well','app',d)).toHaveLength(0);
 expect(await reconcileLateAppMatches('Other','app',deps())).toHaveLength(0);
});

