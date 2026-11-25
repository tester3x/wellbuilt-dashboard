import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerCoordinator} from './worker-coordinator.mjs';
import {Transport} from './transport.mjs';
import {PhotoInbox} from './photo-inbox.mjs';
import {RemoteReviews} from './remote-review.mjs';
import {createHash} from 'node:crypto';

test('idle completed rows are audited once, not every heartbeat; checkpoints survive restart',async()=>{
 const original=Date.now;let now=1800000000000;Date.now=()=>now;
 try{
  const calls=[];const queue={data:{messages:{m:{id:'m',channel:'g',rows:[{id:'r'}]}},deliveries:{r:{status:'complete',identity:'i',packetId:'p'}}},save(){}};
  const request=async(e)=>{calls.push(e);return e==='claimWatchdogMessageV2'?{receipt:{identity:'i',packetId:'p',alreadyRecorded:true}}:{};};
  const c=new WorkerCoordinator(queue,{workerId:'rog-main'},request);
  await c.tick({state:'Connected'});
  for(let i=0;i<20;i++){now+=30000;await c.tick({state:'Connected'});}
  assert.equal(calls.filter(x=>x==='claimWatchdogMessageV2').length,1);
  assert.equal(calls.filter(x=>x==='reportWatchdogWorkerV2').length,11);
  await new WorkerCoordinator(queue,{workerId:'rog-main'},request).tick({state:'Connected'});
  assert.equal(calls.filter(x=>x==='claimWatchdogMessageV2').length,1);
  now+=6*3600000;await c.tick({state:'Connected'});
  assert.equal(calls.filter(x=>x==='claimWatchdogMessageV2').length,2);
  assert.ok(!calls.includes('ingestWatchdogPullV2'));
 }finally{Date.now=original;}
});

test('idle lifecycle checks slow down but new pending work refreshes policy promptly',async()=>{
 const original=Date.now;let now=1800000000000;Date.now=()=>now;
 try{
  const queue={data:{messages:{},deliveries:{}},save(){},reparseChannels(){}};
  const t=new Transport(queue);t.secret='test';t.config={enabled:true,enabledAt:0};const calls=[];
  t.request=async e=>{calls.push(e);return {wells:[]};};
  await t.tick(false);now+=60000;await t.tick(false);
  assert.equal(calls.length,1);
  queue.data.messages.m={id:'m',postedAt:new Date(now).toISOString(),rows:[{id:'r',postedAt:new Date(now).toISOString(),dateTimeUTC:new Date(now).toISOString(),issues:['Manual review'],wellName:'w'}],notices:[]};
  await t.tick(false);assert.equal(calls.filter(x=>x==='getWatchdogWellLifecycleV2').length,2);
  assert.ok(!calls.includes('ingestWatchdogPullV2'));
 }finally{Date.now=original;}
});

test('unchanged unresolved photo checks back off without downloading or sending a load',async()=>{
 const original=Date.now;let now=1800000000000;Date.now=()=>now;
 try{
  const post={id:'m',channel:'g',body:'test',rows:[{id:'r',photo:{autoSend:false}}]};
  const key=createHash('sha256').update('g:m').digest('hex');
  const revision=createHash('sha256').update(JSON.stringify([post.digest,post.rows,post.body,post.chat])).digest('hex');
  const q={data:{messages:{m:post},photoInbox:{[key]:{complete:true,revision,snapshot:{},receiptCheckedAt:now}}},save(){}};
  const calls=[];const p=new PhotoInbox(q,{secret:'test',request:async e=>{calls.push(e);return {messageHash:key,recordedCount:0};}},()=>assert.fail('No repeated upload'));
  now+=60000;await p.tick([{id:'g'}]);assert.equal(calls.length,1);
  now+=60000;await p.tick([{id:'g'}]);assert.equal(calls.length,1);
  now+=60000;await p.tick([{id:'g'}]);assert.equal(calls.length,2);
  assert.ok(calls.every(x=>x==='syncWatchdogPhotoInboxV2'));
 }finally{Date.now=original;}
});

test('unchanged office holds poll every five minutes; changes sync immediately',async()=>{
 const original=Date.now;let now=1800000000000;Date.now=()=>now;
 try{
  const q={data:{messages:{m:{id:'m',channel:'g',digest:'d',rows:[{id:'r',issues:[]}]}},deliveries:{r:{status:'review'}}},save(){}};
  let calls=0;const r=new RemoteReviews(q,{secret:'test',request:async()=>{calls++;return {};} });
  await r.tick([]);now+=30000;await r.tick([]);assert.equal(calls,1);
  q.data.deliveries.r.issues=['Changed'];await r.tick([]);assert.equal(calls,2);
  now+=300000;await r.tick([]);assert.equal(calls,3);
 }finally{Date.now=original;}
});
