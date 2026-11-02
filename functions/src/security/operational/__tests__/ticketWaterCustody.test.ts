import { assertNoUnfinishedTicketJobs, splitCancellationPlan, unfinishedTicketInvoice } from '../ticketWaterCustody';
const b = {companyId:'c', driverId:'d', splitGroupId:'g', splitSequence:2, status:'pending'};
const a = {...b, splitSequence:1, status:'completed'};
test('middle cancellation releases its allocation without adding water; last split requires disposition',()=>{
 const next={...b,id:'c',splitSequence:3,status:'pending'};
 expect(splitCancellationPlan({...b,status:'in_progress'},[a,next],{dispatchCarryBbls:120,totalBBL:40})).toEqual({kind:'release',nextDispatchId:'c',remainingBbls:120,releasedAllocatedBbls:40,splitGroupId:'g'});
 expect(splitCancellationPlan(b,[a])).toEqual({kind:'divert'});
 expect(splitCancellationPlan({...b,status:'in_progress'},[a],{dispatchCarryBbls:120,totalBBL:0})).toEqual({kind:'divert'});
 expect(splitCancellationPlan({...b,status:'in_progress'},[a],{dispatchCarryBbls:0,totalBBL:0})).toEqual({kind:'empty'});
 expect(splitCancellationPlan(b,[{...a,status:'cancelled'}])).toEqual({kind:'unstarted'});
 expect(splitCancellationPlan({...b,status:'in_progress'},[a,next],{totalBBL:40})).toEqual({kind:'unverified'});
 expect(splitCancellationPlan({...b,status:'in_progress'},[a,{...next,driverId:'other'}],{dispatchCarryBbls:120})).toEqual({kind:'divert'});
});
test('only real open invoices block closing; queued previews and terminal jobs do not',()=>{
  for(const value of [{timeline:[{type:'accept'}]},{totalBBL:60},{dispatchId:'b',dispatchSplitGroupId:'g'}])expect(unfinishedTicketInvoice({status:'open',...value})).toBe(true);
  for(const value of [{previewNotStarted:true},{_invoiceDeferredCreate:true}])expect(unfinishedTicketInvoice({status:'open',totalBBL:60,...value})).toBe(false);
  for(const status of ['closed','cancelled','void'])expect(unfinishedTicketInvoice({status,totalBBL:60})).toBe(false);
  expect(unfinishedTicketInvoice({status:'open',timeline:[]})).toBe(false);
});
function harness(rows: Record<string,any[] | undefined> = {}, fail=false){
  const reads:any[]=[];
  const db={collection:(name:string)=>{const q:any={name,filters:[],where:(...f:any[])=>{q.filters.push(f);return q;}};return q;}};
  const tx={get:async(q:any)=>{reads.push(q);if(fail)throw Error('offline');const values=rows[q.name+'/'+q.filters.at(-1)[2]]||[];return {empty:!values.length,docs:values.map(data=>({data:()=>data}))};}};
  return {reads,run:()=>assertNoUnfinishedTicketJobs(tx as any,db as any,{companyId:'c',driverId:'d'})};
}
test('guard scopes every read to authenticated subject; queued-only permits close',async()=>{
  const h=harness();await h.run();expect(h.reads).toHaveLength(3);
  for(const q of h.reads)expect(q.filters.slice(0,2)).toEqual([['companyId','==','c'],['driverId','==','d']]);
});
test('active dispatch, paused job, loaded invoice and read failure all block close',async()=>{
  for(const rows of [{'dispatches/in_progress':[{}]},{'dispatches/paused':[{}]},{'invoices/open':[{status:'open',totalBBL:60}]}])await expect(harness(rows).run()).rejects.toThrow('unfinished_ticket_jobs');
  await expect(harness({},true).run()).rejects.toThrow('offline');
});

test('each middle C/D/E/F releases only its reservation; cancelled future legs make current the last',()=>{
 for(const splitSequence of [2,3,4,5,6]){const current={...b,splitSequence,status:'in_progress'};const next={...b,id:'next',splitSequence:splitSequence+1,status:'pending'};const invoice={dispatchCarryBbls:120,totalBBL:40};
 expect(splitCancellationPlan(current,[a,next],invoice)).toMatchObject({kind:'release',remainingBbls:120,releasedAllocatedBbls:40,nextDispatchId:'next'});
 expect(splitCancellationPlan(current,[a,{...next,status:'cancelled'}],invoice)).toMatchObject({kind:'divert'});
 }
});
