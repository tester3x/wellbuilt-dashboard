jest.mock('firebase-functions/v2/https',()=>({HttpsError:class extends Error{constructor(public code:string,message:string){super(message)}}}));
jest.mock('firebase-admin/firestore',()=>({FieldValue:{delete:()=>null,serverTimestamp:()=>123456}}));
import {resolveBuilderCancellation, originalBuilder} from '../builderCancellation';
const driver={driverId:'driver',companyId:'company',displayName:'Driver'};
let rows:Map<string,any>,written:string[];
function database():any {
 const doc=(collection:string,id:string)=>({path:`${collection}/${id}`,id});
 const query=(collection:string,filters:any[]=[]):any=>({collection,filters,doc:(id:string)=>doc(collection,id),where:(field:string,_op:string,value:any)=>query(collection,[...filters,[field,value]])});
 return {collection:(name:string)=>query(name),runTransaction:async(fn:any)=>{
  const changes:any[]=[];let writing=false;
  const snap=(path:string)=>({id:path.split('/').pop(),ref:{path},exists:rows.has(path),data:()=>structuredClone(rows.get(path))});
  const result=await fn({get:async(ref:any)=>{if(writing)throw Error('read after write');if(ref.path)return snap(ref.path);return {docs:[...rows.keys()].filter(p=>p.startsWith(ref.collection+'/')&&ref.filters.every(([k,v]:any)=>rows.get(p)[k]===v)).map(snap)}},update:(ref:any,patch:any)=>{writing=true;changes.push([ref.path,patch])},set:(ref:any,patch:any)=>{writing=true;changes.push([ref.path,patch])}});
  for(const [path,patch] of changes){rows.set(path,{...(rows.get(path)||{}),...patch});written.push(path)}return result;
 }};
}
const call=(extra:any={})=>resolveBuilderCancellation(database(),driver,{dispatchId:'job',action:'cancel_job',invoiceDocId:'inv',reason:'',...extra});
beforeEach(()=>{written=[];rows=new Map([
 ['dispatches/job',{companyId:'company',driverId:'driver',status:'in_progress',invoiceDocId:'inv',assignedAt:1000,source:'driver',assignedBy:'driver'}],
 ['invoices/inv',{companyId:'company',driverId:'driver',dispatchId:'job',status:'open',totalBBL:0,tickets:[]}],
 ]);});
test.each(['driver','staff'])('%s-built started and queued jobs resolve by original builder, not entry point',async kind=>{
 Object.assign(rows.get('dispatches/job'),{builderOwnership:{kind,actorId:kind==='driver'?'driver':'staff-uid'},jobCreationPoint:'driver'});
 const r=await call();expect(r).toMatchObject({ok:true,cancellationPolicy:'builder-v1',result:kind==='driver'?'cancelled':'declined',affectedDispatchIds:['job']});expect(rows.get('invoices/inv').status).toBe('cancelled');expect(rows.get('dispatches/job').cancelReason).toBe('');
 rows.get('dispatches/job').status='pending';rows.get('dispatches/job').invoiceDocId=undefined;rows.get('dispatches/job').driverCancellation=undefined;
 expect(await call({invoiceDocId:undefined,expectedAssignedAtMs:1000,requestedAtMs:2000})).toMatchObject({result:kind==='driver'?'cancelled':'declined'});
});
test('same request replays its receipt without another mutation',async()=>{const r=await call();written=[];expect(await call()).toEqual(r);expect(written).toEqual([])});
test('queued cancellation cannot cancel a newer assignment or reuse a stale receipt',async()=>{
 Object.assign(rows.get('dispatches/job'),{status:'pending',invoiceDocId:undefined});const request={invoiceDocId:undefined,expectedAssignedAtMs:1000,requestedAtMs:2000};await call(request);written=[];Object.assign(rows.get('dispatches/job'),{status:'pending',assignedAt:3000});await expect(call(request)).rejects.toThrow('Assignment changed');expect(written).toEqual([]);
});
test.each([{companyId:'other'},{driverId:'other'}])('wrong tenant or driver writes nothing %j',async patch=>{Object.assign(rows.get('dispatches/job'),patch);await expect(call()).rejects.toThrow('ownership');expect(written).toEqual([])});
test('wrong invoice, missing builder, and ambiguous builder retain every record',async()=>{
 await expect(call({invoiceDocId:'old'})).rejects.toThrow('earlier invoice');Object.assign(rows.get('dispatches/job'),{source:undefined,assignedBy:undefined});await expect(call()).rejects.toThrow('missing');Object.assign(rows.get('dispatches/job'),{source:'staff',assignedBy:'driver'});await expect(call()).rejects.toThrow('Conflicting');expect(written).toEqual([]);
});
test.each([{totalBBL:140},{tickets:['ticket']},{transferSourceDocId:'source'},{lockedForTransfer:true}])('loaded/transferred work refuses atomically %j',async patch=>{Object.assign(rows.get('invoices/inv'),patch);await expect(call()).rejects.toThrow('Loaded');expect(written).toEqual([])});
function family(seq:number){Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:seq});rows.set('dispatches/anchor',{companyId:'company',driverId:'driver',source:'driver',assignedBy:'driver',splitGroupId:'g',splitSequence:1,status:'completed'});rows.set('dispatches/next',{companyId:'company',driverId:'driver',source:'driver',assignedBy:'driver',splitGroupId:'g',splitSequence:seq+1,status:'pending'});}
test('middle split releases its allocation once and returns the identical durable carry',async()=>{
 family(2);Object.assign(rows.get('invoices/inv'),{totalBBL:40,dispatchCarryBbls:120});const r=await call();expect(r.splitCancellationCarry).toEqual({nextDispatchId:'next',remainingBbls:120,releasedAllocatedBbls:40,splitGroupId:'g'});expect(rows.get('dispatches/next').inheritedBbls).toBe(120);expect(written).not.toContain('dispatches/anchor');written=[];rows.get('dispatches/next').status='completed';expect(await call()).toEqual(r);expect(written).toEqual([]);
});
test('last split with water refuses before any writes',async()=>{family(2);rows.delete('dispatches/next');Object.assign(rows.get('invoices/inv'),{totalBBL:40,dispatchCarryBbls:120});await expect(call()).rejects.toThrow('still holds water');expect(written).toEqual([])});
test('unloaded A cancels the unresolved family atomically, preserving completed members',async()=>{
 Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:1});rows.set('dispatches/b',{companyId:'company',driverId:'driver',source:'driver',assignedBy:'driver',splitGroupId:'g',splitSequence:2,status:'pending'});rows.set('dispatches/complete',{companyId:'company',driverId:'driver',source:'driver',assignedBy:'driver',splitGroupId:'g',splitSequence:3,status:'completed'});
 expect(await call()).toMatchObject({affectedDispatchIds:['job','b']});expect(rows.get('dispatches/b').status).toBe('cancelled');expect(written).not.toContain('dispatches/complete');expect(written.every(path=>/^(dispatches|invoices|split_load_ledgers)\//.test(path))).toBe(true);
});
test('one loaded sibling or foreign family member refuses the whole A transaction',async()=>{
 Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:1});rows.set('dispatches/b',{companyId:'foreign',driverId:'driver',splitGroupId:'g',splitSequence:2,status:'pending'});await expect(call()).rejects.toThrow('ownership');expect(written).toEqual([]);rows.get('dispatches/b').companyId='company';Object.assign(rows.get('dispatches/b'),{source:'driver',invoiceDocId:'b-inv'});rows.set('invoices/b-inv',{companyId:'company',driverId:'driver',dispatchId:'b',status:'open',totalBBL:10});await expect(call()).rejects.toThrow('Loaded');expect(written).toEqual([]);
});
test('completed work is never acknowledged as a successful new cancellation',async()=>{rows.get('dispatches/job').status='completed';await expect(call()).rejects.toThrow('Completed');expect(written).toEqual([])});
test('authoritative birth stamp wins over mutable presentation aliases',()=>{expect(originalBuilder({source:'driver',assignedBy:'driver',builderOwnership:{kind:'staff',actorId:'original'}})).toEqual({kind:'staff',actorId:'original'})});
import {materializeDriverCreate} from '../createDriverDispatch';
import {rejectCallerAuthorityFields} from '../dispatchPacketPin';
test('driver create stamps original builder after all request fields',()=>{
 const fields=materializeDriverCreate({caller:{driverId:'canonical',companyId:'company'},fields:{builderOwnership:{kind:'staff',actorId:'forged'}},jobTypeId:'pw',binding:{packageId:'p',packetRevision:1,contentHash:'h',policyHash:'p'}});
 expect(fields.builderOwnership).toEqual({kind:'driver',actorId:'canonical'});
 expect(rejectCallerAuthorityFields({builderOwnership:{kind:'staff',actorId:'forged'}})).toMatchObject({ok:false});
});
