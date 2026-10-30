import test from 'node:test';
import assert from 'node:assert/strict';
import {dismissReview} from './dismiss-review.mjs';
import {Transport} from './transport.mjs';
const make=delivery=>({data:{deliveries:{row:delivery},messages:{}},save(){this.saves=(this.saves||0)+1;},reparseChannels(){}});
test('orphan and rejected entries can be dismissed without replay eligibility',()=>{
 for(const delivery of [{status:'review',issues:['Unreadable levels']},{status:'review',identity:'held',packetId:'old',needsReview:true}]){
  const q=make(delivery);assert.equal(dismissReview(q,{rowId:'row',category:'not_a_load'}).status,'archived');
  assert.equal(q.data.deliveries.row.reviewDismissal.previousStatus,'review');
  assert.equal(q.data.deliveries.row.identity,delivery.identity);assert.equal(q.saves,1);
  assert.equal(dismissReview(q,{rowId:'row'}).alreadyDismissed,true);assert.equal(q.saves,1);
 }
});
test('duplicate disposition preserves receipt identity and all measurements',()=>{
 const d={status:'review',identity:'owned',packetId:'packet',needsReview:true,measurements:{bblsTaken:170},issues:['held']},q=make(d);
 dismissReview(q,{rowId:'row',category:'duplicate',reason:'Existing manual load'});
 assert.equal(q.data.deliveries.row.status,'duplicate');assert.equal(q.data.deliveries.row.packetId,d.packetId);
 assert.deepEqual(q.data.deliveries.row.measurements,d.measurements);assert.deepEqual(q.data.deliveries.row.issues,d.issues);
});
test('clearing estimated reviews never confirms volume or resends archived loads',async()=>{
 const d={status:'incomplete',needsReview:true,identity:'owned',packetId:'packet',barrelSource:'estimated',estimate:{estimatedBbls:51},measurements:{bblsTaken:51}},q=make(d);
 dismissReview(q,{rowId:'row',reason:'Historical review cleared; estimate remains unverified'});
 assert.equal(q.data.deliveries.row.barrelSource,'estimated');assert.deepEqual(q.data.deliveries.row.estimate,d.estimate);
 assert.deepEqual(q.data.deliveries.row.measurements,d.measurements);
 const t=new Transport(q);t.secret='synthetic';t.config={enabled:true};t.lastLifecycleCheck=Date.now();t.request=async()=>{throw Error('Archived review must not be sent or refreshed')};
 await t.tick(false);assert.equal(t.status,'Ready');const result=await t.reconcileReceipts();assert.equal(result.refreshed,0);
 assert.equal(q.data.deliveries.row.status,'archived');
});
test('unknown, normal pending and invalid categories are rejected; failed persistence rolls back',()=>{
 const q=make({status:'queued',needsReview:false});assert.throws(()=>dismissReview(q,{rowId:'missing'}));assert.throws(()=>dismissReview(q,{rowId:'row'}));
 q.data.deliveries.row.status='review';assert.throws(()=>dismissReview(q,{rowId:'row',category:'delete'}));
 const before=q.data.deliveries.row;q.save=()=>{throw Error('disk failure')};assert.throws(()=>dismissReview(q,{rowId:'row'}));assert.equal(q.data.deliveries.row,before);
});
