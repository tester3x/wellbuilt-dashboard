import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport} from './transport.mjs';
function setup(){
 const queue={data:{deliveries:{old:{identity:'identity',packetId:'packet',status:'queued'}}},save(){}};
 const transport=new Transport(queue);transport.secret='test-only';transport.config={enabled:true};
 return {queue,transport};
}
test('refresh acknowledges an existing packet without ingesting another pull',async()=>{
 const {queue,transport}=setup();const calls=[];
 transport.request=async(endpoint,body)=>{calls.push(endpoint);return {ok:true,identity:body.identity,packetId:'packet',status:'complete'};};
 assert.equal((await transport.reconcileReceipts()).pending,0);
 assert.equal(queue.data.deliveries.old.status,'complete');
 assert.deepEqual(calls,['getWatchdogPullReceiptV2']);
});
test('a missing cloud packet remains pending, never gets recreated',async()=>{
 const {queue,transport}=setup();
 transport.request=async()=>({ok:true,identity:'identity',packetId:'packet',status:'queued'});
 assert.equal((await transport.reconcileReceipts()).pending,1);
 assert.equal(queue.data.deliveries.old.status,'queued');
});
test('newly captured work survives receipt refresh',async()=>{
 const {queue,transport}=setup();
 transport.request=async()=>{queue.data.deliveries.new={status:'review'};return {ok:true,identity:'identity',packetId:'packet',status:'complete'};};
 await transport.reconcileReceipts();assert.equal(queue.data.deliveries.new.status,'review');
});
test('mismatched receipt and concurrent corrections cannot overwrite work',async()=>{
 const {queue,transport}=setup();
 transport.request=async()=>({ok:true,identity:'another',packetId:'packet',status:'complete'});
 assert.equal((await transport.reconcileReceipts()).errors,1);assert.equal(queue.data.deliveries.old.status,'queued');
 transport.request=async()=>{queue.data.deliveries.old.correctionPending=true;return {ok:true,identity:'identity',packetId:'packet',status:'complete'};};
 assert.equal((await transport.reconcileReceipts()).refreshed,0);assert.equal(queue.data.deliveries.old.correctionPending,true);
});
test('delivery and review mutations retain their existing busy guard',async()=>{
 const {transport}=setup();transport.busy=true;await assert.rejects(()=>transport.reconcileReceipts(),/Delivery in progress/);
});
