const documents=new Map<string,any>(),database=new Map<string,any>();let failWrite=false;
const snapshot=(value:any)=>({val:()=>value,exists:()=>value!==undefined});
const doc=(key:string)=>({key,get:async()=>({exists:documents.has(key),data:()=>documents.get(key)})});
jest.mock('firebase-admin',()=>({
 firestore:()=>({doc,runTransaction:async(fn:any)=>fn({get:(r:any)=>r.get(),set:(r:any,v:any)=>documents.set(r.key,v),update:(r:any,v:any)=>documents.set(r.key,{...documents.get(r.key),...v})})}),
 database:()=>({ref:(key:string)=>({once:async()=>snapshot(database.get(key)),orderByChild:()=>({equalTo:(well:string)=>({once:async()=>snapshot(Object.fromEntries([...database].filter(([k,v])=>k.startsWith(key+'/')&&v.wellName===well).map(([k,v])=>[k.slice(key.length+1),v])))})}),transaction:async(fn:any)=>{if(failWrite){failWrite=false;throw Error('network interrupted');}const current=database.get(key),next=fn(current);if(next!==undefined)database.set(key,next);return {committed:next!==undefined,snapshot:snapshot(database.get(key))};}})})
}));
import {digest} from '../../imports/pullImportModel';
import {resolveRejectedReview,historicalResolutionReceipt} from '../rejectedResolution';
const row={id:'row',wellName:'Well',postedAt:'2026-10-20T01:00:00.000Z',dateTimeUTC:'2026-10-20T01:00:00.000Z',tankLevelFeet:12,bottomLevelFeet:8,bblsTaken:160,author:'Driver',source:'Original',issues:[],excluded:false};
const identity=digest([row.wellName,row.dateTimeUTC,row.tankLevelFeet,row.bottomLevelFeet,row.bblsTaken]);
const id='a'.repeat(64),revision='b'.repeat(64),itemKey='watchdog_review_inbox/liquid-gold/items/'+id,entryKey='watchdog_v2_deliveries/'+identity;
const input={companyId:'liquid-gold',id,revision,decision:'record_history',reason:'Verified actual older load'};
const original={packetId:'original',wellName:'Well',tankLevelFeet:12,bblsTaken:160,dateTimeUTC:row.dateTimeUTC,watchdogProvenance:{principalId:'laptop-watchdog-v2',observationDigest:identity,reportedBottomFeet:8}};
beforeEach(()=>{documents.clear();database.clear();failWrite=false;
 documents.set(itemKey,{companyId:'liquid-gold',channel:'group',rowId:'row',row,status:'review',revision,editable:false});
 documents.set(entryKey,{identity,packetId:'original',wellName:'Well',dateTimeUTC:row.dateTimeUTC,top:12,bottom:8,reportedBottomFeet:8,bbl:160,principalId:'laptop-watchdog-v2'});
 documents.set('watchdog_v2_config/laptop',{enabled:true,channels:{group:{wells:['Well']}}});
 database.set('packets/rejected/original',{packetId:'original',reason:'STALE_PULL_TIME',packet:original});
 database.set('well_config/Well',{tanks:2,tankHeight:20});
 for(const [id,time]of [['previous','00:00'],['newer','02:00']])database.set('packets/processed/'+id,{packetId:id,wellName:'Well',dateTimeUTC:'2026-10-20T'+time+':00.000Z',tankLevelFeet:12,bblsTaken:160});
 database.set('wells/Well/status',{lastPull:{packetId:'newer'},current:{level:'12'}});database.set('packets/outgoing/Well',{packetId:'newer'});
});
test('records exact older load with audited receipt, preserves live state and is idempotent',async()=>{
 const before=JSON.stringify([...database].filter(([k])=>!k.startsWith('packets/processed/')));
 const result=await resolveRejectedReview(input,'manager');expect(result).toMatchObject({status:'complete',historicalOnly:true,identity,packetId:'original'});
 const packet=database.get('packets/processed/original');expect(packet).toMatchObject({historicalOnly:true,tankAfterInches:96,wellName:'Well',bblsTaken:160});expect(packet.canonicalProcessingComplete).toBeUndefined();
 expect(JSON.stringify([...database].filter(([k])=>!k.startsWith('packets/processed/')))).toBe(before);
 expect(await resolveRejectedReview(input,'manager')).toEqual(result);expect([...database.keys()].filter(k=>k.startsWith('packets/processed/'))).toHaveLength(3);
 expect(documents.get(itemKey).status).toBe('complete');expect([...documents.values()].some(v=>v.state==='complete'&&v.actorUid==='manager')).toBe(true);
});
test('bad ownership, stale revision, scope and non-stale reason cannot create history',async()=>{
 await expect(resolveRejectedReview({...input,companyId:'other'},'manager')).rejects.toThrow('Invalid');
 await expect(resolveRejectedReview({...input,revision:'c'.repeat(64)},'manager')).rejects.toThrow('changed');
 database.set('packets/rejected/original',{packetId:'original',reason:'INVALID_LEVEL',packet:original});await expect(resolveRejectedReview(input,'manager')).rejects.toThrow('Only stale');
 database.set('packets/rejected/original',{packetId:'original',reason:'STALE_PULL_TIME',packet:{...original,watchdogProvenance:{}}});await expect(resolveRejectedReview(input,'manager')).rejects.toThrow('Owned');
 expect(database.has('packets/processed/original')).toBe(false);
});
test('interrupted historical write retains rejection, releases claim and retries safely',async()=>{
 failWrite=true;await expect(resolveRejectedReview(input,'manager')).rejects.toThrow('network interrupted');
 expect(documents.get(itemKey).resolutionPending).toBeNull();expect(documents.get(itemKey).status).toBe('review');expect(database.has('packets/rejected/original')).toBe(true);
 expect((await resolveRejectedReview(input,'manager')).status).toBe('complete');
});
test('exclusion acknowledges office decision without removing original rejection',async()=>{
 const result=await resolveRejectedReview({...input,decision:'exclude'},'manager');expect(result.status).toBe('excluded');expect(database.has('packets/rejected/original')).toBe(true);expect(database.has('packets/processed/original')).toBe(false);
});
test('unbound or forged historical packets cannot become confirmed receipts',async()=>{
 const entry=documents.get(entryKey);expect(historicalResolutionReceipt(entry,{},identity)).toBeNull();
 await resolveRejectedReview(input,'manager');const resolved=documents.get(entryKey),packet=database.get('packets/processed/original');
 for(const change of [{bblsTaken:999},{wellName:'Foreign'},{historicalOnly:false},{watchdogHistoricalResolution:{id:'foreign'}}])expect(historicalResolutionReceipt(resolved,{...packet,...change},identity)).toBeNull();
});
