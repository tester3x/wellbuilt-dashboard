jest.mock('firebase-functions/v2/https',()=>({onCall:(_options:any,handler:any)=>handler,
  HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('firebase-admin',()=>({firestore:Object.assign(jest.fn(),{Timestamp:{now:()=> 'NOW'}})}));
jest.mock('../../requireDriverAuth',()=>({requireSecureDriver:jest.fn(async(request:any,options:any)=>{
  if(options.allowLegacyHash!==false)throw Error('Legacy authentication must be disabled');
  if(request.auth?.uid!=='uid')throw Error('unauthenticated');
  return {companyId:'company',driverId:'driver'};
})}));
import * as admin from 'firebase-admin';
import {resequenceSplitFamily} from '../../resequenceSplitFamilyCallable';
const invoke=resequenceSplitFamily as unknown as (request:any)=>Promise<any>;
function fixture(){
  const data=new Map<string,any>();let event=0;
  const writes:any[]=[];
  for(const [id,seq,well] of [['a',1,'Source'],['b',2,'First'],['c',3,'Second']] as const)
    data.set('dispatches/'+id,{companyId:'company',driverId:'driver',driverHash:'legacy',splitGroupId:'group',
      splitSequence:seq,splitTotal:3,status:'pending',wellName:well,disposal:id==='a'?'First':well});
  const doc=(path:string)=>({path,id:path.split('/').pop()});
  const snap=(path:string)=>({ref:doc(path),id:path.split('/').pop(),exists:data.has(path),data:()=>data.get(path)});
  const collection=(path:string)=>({doc:(id?:string)=>doc(path+'/'+(id||'event-'+(++event))),
    where:(field:string,_op:string,value:any)=>({collection:path,field,value,limit(){return this;}})});
  (admin.firestore as unknown as jest.Mock).mockReturnValue({collection,runTransaction:async(run:any)=>{
    const staged:any[]=[];let mutated=false;
    const result=await run({get:async(ref:any)=>{
      if(mutated)throw Error('Read after write');
      if(ref.path)return snap(ref.path);
      const docs=[...data.keys()].filter(p=>p.startsWith(ref.collection+'/')&&data.get(p)[ref.field]===ref.value).map(snap);
      return {docs,size:docs.length,empty:docs.length===0};
    },update:(ref:any,patch:any)=>{mutated=true;staged.push({kind:'update',path:ref.path,patch});},
      create:(ref:any,patch:any)=>{mutated=true;staged.push({kind:'create',path:ref.path,patch});}});
    for(const w of staged){data.set(w.path,w.kind==='create'?w.patch:{...data.get(w.path),...w.patch});writes.push(w);}
    return result;
  }});
  const request=(ids=['a','c','b'])=>({auth:{uid:'uid'},data:{splitGroupId:'group',orderedLegIds:ids,callerDriverHash:'spoofed'}});
  return {data,writes,request};
}
test('strict authenticated transaction updates route/order/invoice and one separate audit; replay has no writes',async()=>{
  const f=fixture();f.data.get('dispatches/a').invoiceDocId='invoice-a';
  const signed={signature:'unchanged',photos:['photo'],barrels:140,timeline:[{type:'accept',at:123}]};
  f.data.set('invoices/invoice-a',{companyId:'company',driverId:'driver',dispatchId:'a',dispatchSplitGroupId:'group',
    status:'open',hauledTo:'First',...signed});
  f.data.set('jsas/signed',{immutable:'signed snapshot'});
  expect(await invoke(f.request())).toMatchObject({newTotal:3,order:[{id:'a',splitSequence:1},{id:'c',splitSequence:2},{id:'b',splitSequence:3}]});
  expect(f.data.get('dispatches/a').disposal).toBe('Second');
  expect(f.data.get('invoices/invoice-a')).toMatchObject({...signed,hauledTo:'Second',dispatchSplitSequence:1});
  expect(f.data.get('jsas/signed')).toEqual({immutable:'signed snapshot'});
  expect(f.writes.filter(w=>w.path.startsWith('split_reorder_events/'))).toHaveLength(1);
  f.writes.length=0;await invoke(f.request());expect(f.writes).toEqual([]);
});
test.each(['unauthenticated','foreign-family','foreign-history','foreign-invoice','transfer','departed','duplicate','moved-anchor'])(
  '%s refuses without any mutation',async failure=>{
    const f=fixture();const request=f.request();
    if(failure==='unauthenticated')delete (request as any).auth;
    if(failure==='foreign-family')f.data.get('dispatches/b').companyId='other';
    if(failure==='foreign-history')f.data.set('dispatches/old',{...f.data.get('dispatches/b'),companyId:'other',status:'cancelled'});
    if(failure==='transfer')f.data.get('dispatches/c').lockedForTransfer=true;
    if(failure==='duplicate')request.data.orderedLegIds=['a','b','b'];
    if(failure==='moved-anchor')request.data.orderedLegIds=['b','a','c'];
    if(failure==='foreign-invoice'||failure==='departed'){
      f.data.get('dispatches/a').invoiceDocId='invoice-a';
      f.data.set('invoices/invoice-a',{companyId:failure==='foreign-invoice'?'other':'company',driverId:'driver',
        dispatchId:'a',dispatchSplitGroupId:'group',status:'open',timeline:failure==='departed'?[{type:'depart_site'}]:[]});
    }
    const before=JSON.stringify([...f.data]);
    await expect(invoke(request)).rejects.toThrow();expect(f.writes).toEqual([]);expect(JSON.stringify([...f.data])).toBe(before);
  });
test('cancelled records and completed invoice cycles retain all original fields',async()=>{
  const f=fixture(),old={...f.data.get('dispatches/b'),status:'cancelled',reason:'retained'};
  f.data.set('dispatches/old',old);f.data.set('invoices/old-invoice',{companyId:'company',driverId:'driver',
    dispatchId:'old',dispatchSplitGroupId:'group',status:'closed',signature:'retained'});
  await invoke(f.request());expect(f.data.get('dispatches/old')).toEqual(old);
  expect(f.data.get('invoices/old-invoice').signature).toBe('retained');
  expect(f.writes.some(w=>['dispatches/old','invoices/old-invoice'].includes(w.path))).toBe(false);
});
