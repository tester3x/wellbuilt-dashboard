const {test}=require('node:test'),assert=require('node:assert/strict');
const {handleLegacyEvidence}=require('../functions/lib/jsaReceipt/jsaLegacyEvidence');
const uid='synthetic-user',auth={uid,claims:{kind:'driver',app:'jsa',companyId:'synthetic-company',driverId:'synthetic-driver'}};
const stamp=Date.parse('2026-11-24T12:30:00Z'),requestId='R'.repeat(43);
const record=()=>({id:'synthetic-signed',companyId:'synthetic-company',driverId:'synthetic-driver',driverHash:'synthetic-driver',timestamp:new Date(stamp).toISOString(),signature:'Synthetic signature',operator:'Synthetic operator',shiftId:'synthetic-shift',legacyReceiptBinding:{requestId,receiptVersion:1,companyId:'synthetic-company',driverHash:'synthetic-driver',jobDocId:'synthetic-job',shiftId:'synthetic-shift',receivedAt:new Date(stamp-10000).toISOString(),expiresAt:new Date(stamp+10000).toISOString()}});
function fixture(){
 let rows=new Map([['invoices/synthetic-job',{companyId:'synthetic-company',driverId:'synthetic-driver',shiftId:'synthetic-shift'}]]),writes=0;
 const store={transaction:async fn=>{const next=new Map(structuredClone([...rows])),pending=[];const out=await fn({get:async p=>structuredClone(next.get(p)||null),create:(p,r)=>{if(next.has(p))throw Error('already exists');next.set(p,structuredClone(r));pending.push(p);}});rows=next;writes+=pending.length;return out;},list:async(c,d)=>[...rows].filter(([k,r])=>k.startsWith('jsas/')&&r.companyId===c&&r.driverId===d).map(([,r])=>structuredClone(r))};
 return {call:(body,a=auth,member=true)=>handleLegacyEvidence(store,a,body,async()=>member,stamp+60000),put:r=>store.transaction(async tx=>tx.create('jsas/'+r.id,r)),get rows(){return rows;},get writes(){return writes;}};
}
test('authentication, audience, membership and immutable owner are all required',async()=>{
 for(const [a,r,m] of [[{},record(),true],[{...auth,claims:{...auth.claims,app:'wbt'}},record(),true],[auth,record(),false],[auth,{...record(),companyId:'foreign'},true],[auth,{...record(),driverId:'foreign'},true]]){const f=fixture();await assert.rejects(f.call({operation:'store',record:r},a,m));assert.equal(f.writes,0);}
});
test('exact replay after a lost response reuses evidence without changing any signed bytes',async()=>{
 const f=fixture(),r=record(),bytes=JSON.stringify(r);await f.call({operation:'store',record:r});const n=f.writes;const retry=await f.call({operation:'store',record:JSON.parse(bytes)});assert.equal(retry.reused,true);assert.equal(f.writes,n);assert.equal(JSON.stringify(f.rows.get('jsas/'+r.id)),bytes);
 await assert.rejects(f.call({operation:'store',record:{...r,signature:'Changed'}}),/immutable_evidence_conflict/);assert.equal(JSON.stringify(f.rows.get('jsas/'+r.id)),bytes);
});
test('existing owned evidence is never overwritten even when transport metadata differs',async()=>{
 const f=fixture(),r=record();await f.put({...r,syncedAt:'legacy'});const before=JSON.stringify([...f.rows]);await assert.rejects(f.call({operation:'store',record:r}),/immutable/);assert.equal(JSON.stringify([...f.rows]),before);
});
test('receipt waits for archived signed evidence, then remains idempotent and owner-readable',async()=>{
 const f=fixture(),body={operation:'receipt',requestId,recordId:'synthetic-signed'};await assert.rejects(f.call(body),/pending/);await f.call({operation:'store',record:record()});const first=await f.call(body),n=f.writes;const second=await f.call(body);assert.deepEqual(first.receipt,second.receipt);assert.equal(f.writes,n);assert.equal(first.receipt.completedAt,record().timestamp);
 const wbt={...auth,claims:{...auth.claims,app:'wbt'}};assert.deepEqual((await f.call({operation:'get_receipt',requestId},wbt)).receipt,first.receipt);
 await assert.rejects(f.call({operation:'get_receipt',requestId},{uid:'other',claims:{...wbt.claims,companyId:'foreign'}}));
});
test('old unauthenticated receipt is not accepted as proof merely because it exists',async()=>{
 const f=fixture();f.rows.set('jsa_read_receipts/'+requestId,{requestId,companyId:'synthetic-company',driverHash:'synthetic-driver',jsaRecordId:'other'});
 assert.equal((await f.call({operation:'get_receipt',requestId})).receipt,null);
 await f.call({operation:'store',record:record()});await assert.rejects(f.call({operation:'receipt',requestId,recordId:'synthetic-signed'}),/receipt_conflict/);
});
test('receipt refuses wrong job owner, wrong shift and unproven/expired signature binding',async()=>{
 for(const change of ['owner','shift','binding','time']){const f=fixture(),r=record();if(change==='owner')f.rows.get('invoices/synthetic-job').companyId='foreign';if(change==='shift')f.rows.get('invoices/synthetic-job').shiftId='other';if(change==='binding')r.legacyReceiptBinding.requestId='Q'.repeat(43);if(change==='time')r.legacyReceiptBinding.expiresAt=new Date(stamp-1).toISOString();await f.call({operation:'store',record:r});const before=f.writes;await assert.rejects(f.call({operation:'receipt',requestId,recordId:r.id}));assert.equal(f.writes,before);}
});
test('closed-period offline replay retains original time but cannot attach to another period',async()=>{
 const f=fixture(),r=record();Object.assign(r.legacyReceiptBinding,{receiptVersion:2,periodId:'synthetic-period',workPeriodMode:'explicit_shift'});f.rows.set('jsa_work_periods/synthetic-period',{companyId:r.companyId,driverId:r.driverId,createdAtMs:stamp-20000,finalizedAtMs:stamp+20000});f.rows.get('invoices/synthetic-job').jsaPeriodId='synthetic-period';await f.call({operation:'store',record:r});const out=await f.call({operation:'receipt',requestId,recordId:r.id});assert.equal(out.receipt.submissionPeriodId,'synthetic-period');assert.equal(out.receipt.completedAt,r.timestamp);
});
test('governed snapshots never fall back into legacy store and signed deletions have no operation',async()=>{
 const f=fixture();await assert.rejects(f.call({operation:'store',record:{...record(),governedRequestRef:requestId}}));await assert.rejects(f.call({operation:'delete',recordId:'synthetic-signed'}));assert.equal(f.writes,0);
});
