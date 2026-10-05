import {createHmac,createHash,randomBytes} from 'crypto';
const documents=new Map<string,any>();const database=new Map<string,any>();
const snap=(value:any)=>({val:()=>value,exists:()=>value!==undefined});
const doc=(key:string)=>({key,get:async()=>({exists:documents.has(key),data:()=>documents.get(key)})});
jest.mock('firebase-functions/v2/https',()=>({onRequest:(_opts:any,fn:any)=>fn}));
jest.mock('firebase-admin',()=>({
 firestore:()=>({doc,collection:(p:string)=>({doc:(id:string)=>doc(p+'/'+id)}),runTransaction:async(fn:any)=>fn({get:(ref:any)=>ref.get(),set:(ref:any,value:any)=>documents.set(ref.key,value),create:(ref:any,value:any)=>{if(documents.has(ref.key))throw Error('exists');documents.set(ref.key,value);}})}),
 database:()=>({ref:(key:string)=>({once:async()=>snap(database.get(key)),set:async(value:any)=>{database.set(key,value);},orderByChild:()=>({equalTo:(well:string)=>({once:async()=>snap(Object.fromEntries([...database].filter(([k,v])=>k.startsWith(key+'/')&&v.wellName===well).map(([k,v])=>[k.split('/').pop(),v])))})}),transaction:async(fn:any)=>{const next=fn(database.get(key)||null);if(next===undefined)return {committed:false};database.set(key,next);return {committed:true};}})})
}));
import {ingestWatchdogPullV2,getWatchdogPullReceiptV2,stopWatchdogWellV2,getWatchdogWellLifecycleV2} from '../intake';
async function call(endpoint:any,name:string,body:any,tampered=false){const rawBody=Buffer.from(JSON.stringify(body)),timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex');const signature=createHmac('sha256','synthetic-only-key').update(`v1:${name}:POST:${timestamp}:${nonce}:${createHash('sha256').update(rawBody).digest('hex')}`).digest('hex');const req={method:'POST',body,rawBody,headers:{'x-watchdog-key-id':'V1','x-watchdog-timestamp':timestamp,'x-watchdog-nonce':nonce,'x-watchdog-signature':tampered?'0'.repeat(64):signature}};let code=200,result:any;const res={status:(n:number)=>{code=n;return res;},json:(v:any)=>{result=v;return res;}};await (endpoint as any)(req,res);return {code,result};}
beforeEach(()=>{documents.clear();database.clear();process.env.WATCHDOG_HMAC_KEY_V1='synthetic-only-key';documents.set('watchdog_v2_config/laptop',{enabled:true,enabledAt:Date.now()-3600000,channels:{group:{wells:['Kahuna 5']}}});database.set('well_config',{'Kahuna 5':{bblPerFoot:120,tankHeight:25,companyId:'liquid-gold'}});database.set('packets/outgoing/response_existing',{wellName:'Kahuna 5',wellDown:false,currentLevel:'12',lastPullPacketId:'actual-pull',flowRate:'1:00:00'});});
const observation=()=>{const d=new Date();const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));return {chatId:'group',messageId:'message',rowIndex:0,chat:`[${p.month}/${p.day}/${p.year}, ${p.hour}:${p.minute}:${p.second}] Driver: Kahuna 5\nTop 12.5\nBottom 11.125\n165 bbl`};};
test('rejects invalid signature and unconfigured channel',async()=>{expect((await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',observation(),true)).code).toBe(400);expect(database.size).toBe(2);expect((await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...observation(),chatId:'other'})).result.error).toBe('channel_not_allowed');});
test('queues once, retries preserve packet, and receipt requires exact bottom and completion',async()=>{const first=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',observation());expect(first.result.status).toBe('queued');const packet=database.get('packets/incoming/'+first.result.packetId);expect(packet.driverId).toBeNull();const again=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',observation());expect(again.result.packetId).toBe(first.result.packetId);const receipt={identity:first.result.identity};database.set('packets/processed/'+first.result.packetId,{...packet,tankAfterInches:133.5});expect((await call(getWatchdogPullReceiptV2,'getWatchdogPullReceiptV2',receipt)).result.status).toBe('incomplete');database.set('packets/processed/'+first.result.packetId,{...packet,tankAfterInches:133.5,canonicalProcessingComplete:true});expect((await call(getWatchdogPullReceiptV2,'getWatchdogPullReceiptV2',receipt)).result.status).toBe('complete');database.set('packets/processed/'+first.result.packetId,{...packet,tankAfterInches:140,canonicalProcessingComplete:true});expect((await call(getWatchdogPullReceiptV2,'getWatchdogPullReceiptV2',receipt)).result.status).toBe('incomplete');});
test('accepts missing bottom and suppresses activation history',async()=>{expect((await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...observation(),chat:observation().chat.replace('Bottom 11.125\n','')})).result.status).toBe('queued');documents.get('watchdog_v2_config/laptop').enabledAt=Date.now()+1000;expect((await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',observation())).result.status).toBe('before_activation');});

test('reported bottom never overrides calibrated bottom, and impossible removal is held',async()=>{const request={...observation(),chat:observation().chat.replace('Bottom 11.125','Bottom 20')};const answer=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',request);expect(answer.result.status).toBe('queued');const packet=database.get('packets/incoming/'+answer.result.packetId);expect(packet.bottomLevelFeet).toBe(11.125);expect(packet.watchdogProvenance.reportedBottomFeet).toBe(20);const invalid=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...observation(),messageId:'other',chat:observation().chat.replace('Top 12.5','Top 1')});expect(invalid.result.status).toBe('review');expect(invalid.result.issues).toContain('Load exceeds water below the reported top');});
test('review retains corrected time and audit but cannot bypass invalid top or future time',async()=>{
 const body=observation();const corrected=new Date(Date.now()-600000).toISOString();const review={confirmed:true,dateTimeUTC:corrected,reason:'Driver confirmed actual measurement'};
 const accepted=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...body,review});expect(accepted.result.status).toBe('queued');const packet=database.get('packets/incoming/'+accepted.result.packetId);expect(packet.dateTimeUTC).toBe(corrected);expect(packet.watchdogProvenance.review.correctedTime).toBe(corrected);expect(packet.watchdogProvenance.review.originalTime).not.toBe(corrected);
 const invalid=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...body,chat:body.chat.replace('Top 12.5','Top 30'),review});expect(invalid.result.status).toBe('review');
 const future=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...body,review:{...review,dateTimeUTC:new Date(Date.now()+3600000).toISOString()}});expect(future.result.status).toBe('review');
});
test('explicit review clears only nearby-pull warning, never exact duplicates',async()=>{
 const body=observation();const now=Date.now();database.set('packets/processed/previous',{packetId:'previous',wellName:'Kahuna 5',dateTimeUTC:new Date(now-600000).toISOString(),tankLevelFeet:12.5,bblsTaken:165});
 const held=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',body);expect(held.result.status).toBe('review');
 const review={confirmed:true,dateTimeUTC:new Date(now).toISOString(),reason:'Confirmed separate load'};
 const accepted=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...body,review});expect(accepted.result.status).toBe('queued');
 const duplicate=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...body,review:{...review,dateTimeUTC:new Date(now-600000).toISOString()}});expect(duplicate.result.status).toBe('duplicate');
});

test('stop archives only the selected well, queues an idempotent authoritative command and waits for down confirmation',async()=>{
 database.set('well_config/Kahuna 5',{companyId:'liquid-gold'});
 const body={wellName:'Kahuna 5',reason:'Temporary hauling ended'};
 const first=await call(stopWatchdogWellV2,'stopWatchdogWellV2',body);expect(first.code).toBe(200);
 const packet=database.get('packets/incoming/'+first.result.archive.packetId);expect(packet.wellDownIsAuthoritative).toBe(true);expect(packet.wellDown).toBe(true);expect(packet.tankLevelFeet).toBe(0);expect(packet.bblsTaken).toBe(0);expect(database.get('wells/Kahuna 5/status/isDown')).toBe(true);expect(database.get('packets/outgoing/response_existing')).toMatchObject({wellDown:true,currentLevel:'Down',lastPullPacketId:'actual-pull',flowRate:'1:00:00'});
 expect((await call(stopWatchdogWellV2,'stopWatchdogWellV2',body)).result.archive.packetId).toBe(packet.packetId);
 expect((await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',observation())).result.status).toBe('archived');
 expect((await call(getWatchdogWellLifecycleV2,'getWatchdogWellLifecycleV2',{})).result.wells[0].state).toBe('stopping');
 database.set('packets/processed/'+packet.packetId,{...packet,noLevel:true});database.set('wells/Kahuna 5/status/isDown',true);
 expect((await call(getWatchdogWellLifecycleV2,'getWatchdogWellLifecycleV2',{})).result.wells[0].state).toBe('archived');
 expect((await call(stopWatchdogWellV2,'stopWatchdogWellV2',{wellName:'Other',reason:body.reason})).code).toBe(400);
});
test('stop uses explicit well allowlist for legacy configs without company, but rejects another company',async()=>{database.set('well_config/Kahuna 5',{tanks:3});expect((await call(stopWatchdogWellV2,'stopWatchdogWellV2',{wellName:'Kahuna 5',reason:'Hauling ended'})).code).toBe(200);database.set('well_config/Kahuna 5',{companyId:'another-company'});expect((await call(stopWatchdogWellV2,'stopWatchdogWellV2',{wellName:'Kahuna 5',reason:'Hauling ended'})).code).toBe(400);});

test('sender binding stamps canonical driver ownership and preserves source provenance',async()=>{
 const {watchdogSenderKey}=require('../senderOwnership');const senderId='123456789@lid';const policy=documents.get('watchdog_v2_config/laptop');policy.senderBindings={[watchdogSenderKey(senderId)]:{enabled:true,companyId:'liquid-gold',driverId:'driver-test-123'}};
 database.set('drivers/profiles/driver-test-123',{active:true,companyId:'liquid-gold',displayName:'Test Driver',assignedWells:['Kahuna 5']});
 const first=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...observation(),senderId});expect(first.code).toBe(200);const packet=database.get('packets/incoming/'+first.result.packetId);expect(packet.driverId).toBe('driver-test-123');expect(packet.driverName).toBe('Test Driver');expect(packet.source).toBe('whatsapp_watchdog');expect(packet.watchdogProvenance.ownershipSource).toBe('verified_sender_binding');
 expect((await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...observation(),driverId:'forged'})).result.error).toBe('invalid_observation');
});

test('manual aggregate containment blocks an individual load even after ordinary time review',async()=>{
 const body=observation();const rowTime=new Date(Date.now()-600000).toISOString();
 database.set('packets/processed/combined',{packetId:'combined',wellName:'Kahuna 5',dateTimeUTC:rowTime,tankLevelFeet:12.5,tankAfterInches:117,bblsTaken:330});
 const answer=await call(ingestWatchdogPullV2,'ingestWatchdogPullV2',{...body,review:{confirmed:true,dateTimeUTC:new Date().toISOString(),reason:'Confirmed posted time'}});
 expect(answer.result.status).toBe('review');expect(answer.result.aggregatePacketIds).toEqual(['combined']);
 expect([...database.keys()].some(k=>k.startsWith('packets/incoming/'))).toBe(false);
});
