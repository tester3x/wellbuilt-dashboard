import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport} from './transport.mjs';
function fixture(error){
 const rows=['bad','good'].map(id=>({id,wellName:id,postedAt:'2026-10-18T12:00:00Z',dateTimeUTC:'2026-10-18T12:00:00Z',levelOnly:true,issues:[]}));
 const queue={data:{messages:{m:{id:'m',channel:'channel',rows,notices:[],chat:'fixture'}},deliveries:{}},save(){},reparseChannels(){}};
 const t=new Transport(queue);t.secret='fixture';t.config={enabled:true,enabledAt:0};t.lastLifecycleCheck=Date.now();
 t.request=async(endpoint,body)=>{if(endpoint==='ingestWatchdogPullV2'){if(body.rowIndex===0)throw Error(error);return {identity:'good',packetId:'good',status:'queued'};}return {identity:'good',packetId:'good',status:'complete'};};
 return {queue,t};
}
test('sender rejection is retained for review and next load completes; next tick does not revive top-only rejection',async()=>{
 const {queue,t}=fixture('sender_well_out_of_scope');await t.tick(false);
 assert.equal(queue.data.deliveries.bad.status,'review');assert.deepEqual(queue.data.deliveries.bad.issues,['sender_well_out_of_scope']);assert.equal(queue.data.deliveries.good.status,'complete');
 await t.tick(false);assert.equal(queue.data.deliveries.bad.status,'review');assert.equal(t.busy,false);
});
test('transient failure remains retryable without blocking later rows or fabricating completion',async()=>{
 const {queue,t}=fixture('fetch failed');await t.tick(false);assert.equal(queue.data.deliveries.bad.status,'retry');assert.equal(queue.data.deliveries.good.status,'complete');assert.match(t.status,/Retry pending/);
});
