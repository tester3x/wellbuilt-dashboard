import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {Queue,header} from './core.mjs';import {Transport} from './transport.mjs';

test('catch-up sends oldest first, waits for same-well confirmation, and lets other wells proceed',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'watchdog-order-'));
 try{
  const q=new Queue(dir),base=Date.now()-600000;
  q.ingest({id:'newer',channel:'g',chat:header(base+120000,'Driver','Kahuna 5\nTop 12\nBottom 10\n165 bbl')});
  q.ingest({id:'older',channel:'g',chat:header(base,'Driver','Kahuna 5\nTop 12\nBottom 10\n165 bbl')});
  q.ingest({id:'other',channel:'g',chat:header(base+60000,'Driver','Gunslinger 3\nTop 12\nBottom 10\n165 bbl')});
  const t=new Transport(q);t.secret='synthetic';t.config={enabled:true,enabledAt:0};t.lastLifecycleCheck=Date.now();
  const sent=[];let olderComplete=false;
  t.request=async(endpoint,body)=>{
   if(endpoint==='ingestWatchdogPullV2'){sent.push(body.messageId);return {ok:true,status:'queued',identity:body.messageId,packetId:body.messageId};}
   return {ok:true,status:body.identity==='older'&&!olderComplete?'queued':'complete',identity:body.identity,packetId:body.identity};
  };
  await t.tick(false);assert.deepEqual(sent,['older','other']);
  await t.tick(false);assert.deepEqual(sent,['older','other']);
  olderComplete=true;t.receiptChecks={};await t.tick(false);assert.deepEqual(sent,['older','other','newer']);
  assert.equal(Object.values(q.data.deliveries).every(d=>d.status==='complete'),true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('failed intake retains the older observation and never sends its newer sibling first',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'watchdog-order-error-'));
 try{
  const q=new Queue(dir),base=Date.now()-600000;
  for(const [id,offset]of [['newer',60000],['older',0]])q.ingest({id,channel:'g',chat:header(base+offset,'Driver','Kahuna 5\nTop 12\n165 bbl')});
  const t=new Transport(q);t.secret='synthetic';t.config={enabled:true,enabledAt:0};t.lastLifecycleCheck=Date.now();
  const sent=[];t.request=async(_endpoint,body)=>{sent.push(body.messageId);throw Error('offline');};
  await t.tick(false);assert.deepEqual(sent,['older']);assert.equal(Object.keys(new Queue(dir).data.messages).length,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
import {RemoteReviews} from './remote-review.mjs';
test('office reconciliation clears a hold only after a matching server receipt',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'watchdog-resolution-receipt-'));
 try{
  const q=new Queue(dir);q.ingest({id:'p',channel:'g',chat:header(Date.now(),'Driver','Kahuna 5\nTop 12\n165 bbl')});const row=Object.values(q.data.messages)[0].rows[0];q.data.deliveries={[row.id]:{status:'review',identity:'owned',packetId:'original',needsReview:true}};q.save();
  let correct=false;const t={secret:'synthetic',busy:false,request:async()=>({receipt:{status:'complete',identity:correct?'owned':'foreign',packetId:'original'}})};
  const r=new RemoteReviews(q,t);await r.tick([]);assert.equal(q.data.deliveries[row.id].status,'review');assert.match(r.error,/Invalid reconciliation receipt/);
  correct=true;await r.tick([]);assert.equal(new Queue(dir).data.deliveries[row.id].status,'complete');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
