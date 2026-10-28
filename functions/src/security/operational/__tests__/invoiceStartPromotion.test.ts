import { promoteDriverInvoiceStart } from '../invoiceStartPromotion';
const owner={uid:'u',driverId:'d',companyId:'c',authSource:'claims'};
class Failure extends Error { constructor(public code:string,message:string){super(message);} }
function setup(patch:any={}) {
 const writes:any[]=[];
 const invoice={driverId:'d',companyId:'c',dispatchId:'offer',status:'open',...patch.invoice};
 const dispatch={driverId:'d',companyId:'c',invoiceDocId:'job',status:'accepted',...patch.dispatch};
 const deps:any={request:{auth:{uid:'u',token:{kind:'driver',driverId:'d',companyId:'c'}},data:{intent:'start',invoiceId:'job',dispatchId:'offer'}},driver:owner,HttpsError:Failure,serverTimestamp:()=> 'server-time',writeSecurityAudit:jest.fn(),firestore:{collection:(col:string)=>({doc:(id:string)=>({col,id})}),runTransaction:async(fn:any)=>fn({get:async(ref:any)=>({exists:true,data:()=>ref.col==='invoices'?invoice:dispatch}),update:(ref:any,data:any)=>writes.push({ref,data})})}};
 return {deps,writes};
}
it('promotes only prepared flags on the existing job; repeat starts do not write',async()=>{
 const {deps,writes}=setup();expect(await promoteDriverInvoiceStart(deps)).toMatchObject({ok:true,invoiceId:'job',dispatchId:'offer',result:'started'});
 expect(writes).toEqual([{ref:{col:'invoices',id:'job'},data:{previewNotStarted:false,_jsaPreparedAnchor:false,updatedAt:'server-time'}}]);
 const repeat=setup({invoice:{previewNotStarted:false,_jsaPreparedAnchor:false}});expect((await promoteDriverInvoiceStart(repeat.deps)).result).toBe('already_started');expect(repeat.writes).toEqual([]);
});
it.each(['closed','cancelled','completed'])('acknowledges %s work without reopening it',async status=>{
 const {deps,writes}=setup({invoice:{status},dispatch:{status:'cancelled'}});expect((await promoteDriverInvoiceStart(deps)).result).toBe('already_terminal');expect(writes).toEqual([]);
});
it.each([{invoice:{driverId:'other'}},{dispatch:{companyId:'other'}},{invoice:{dispatchId:'other'}},{dispatch:{invoiceDocId:'other'}},{dispatch:{status:'pending'}},{invoice:{lockedForTransfer:true}},{invoice:{activeTransferRequestId:'x'}}])('rejects wrong ownership, binding, stage and transfer lock %#',async patch=>{
 const {deps,writes}=setup(patch);await expect(promoteDriverInvoiceStart(deps)).rejects.toBeInstanceOf(Failure);expect(writes).toEqual([]);
});
it('requires the canonical principal and rejects extra client fields',async()=>{
 for(const mutate of [(d:any)=>{d.request.auth.token.companyId='other'},(d:any)=>{d.request.auth=null},(d:any)=>{d.request.data.invoice={status:'open'}},(d:any)=>{d.driver={...owner,authSource:'legacy_hash'}}]){
  const {deps,writes}=setup();mutate(deps);await expect(promoteDriverInvoiceStart(deps)).rejects.toBeInstanceOf(Failure);expect(writes).toEqual([]);
 }
});
