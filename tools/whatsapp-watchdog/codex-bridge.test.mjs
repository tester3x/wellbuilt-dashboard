import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CodexBridge,workerContext} from './codex-bridge.mjs';
test('lookup context retains requested wells outside the latest ten and live receiver state',()=>{
 const rows=Array.from({length:12},(_,i)=>({id:String(i),wellName:'Gabriel 1',dateTimeUTC:new Date(Date.UTC(2026,9,10,12,i)).toISOString()}));
 rows.push({id:'g3',wellName:'Gunslinger 3',dateTimeUTC:'2026-10-09T19:37:25Z'});
 const q={data:{messages:{one:{rows}},deliveries:{g3:{status:'complete'}}}};
 const c=workerContext(q,'Check G3 flow',{state:'Connected'});
 assert.equal(c.receiver.state,'Connected');assert.ok(c.latestPulls.some(p=>p.row.id==='g3'));assert.equal(c.latestByWell.find(p=>p.row.id==='g3').delivery.status,'complete');
});
test('sandbox-blocked replies are failed even when Codex exits successfully',async()=>{
 const q={directory:'missing-test-folder',data:{codexRequests:{one:{status:'queued',request:'lookup',channel:'overlord'}}},save(){}};
 const bridge=new CodexBridge(q,async()=>"I couldn’t verify the rate: sandbox initialization blocked local access.");bridge.config={enabled:true};await bridge.tick(async()=>{});assert.equal(q.data.codexRequests.one.status,'failed');
});
test('worker serializes jobs and reports once without rerunning completed work',async()=>{
 const q={directory:'missing-test-folder',data:{codexRequests:{one:{status:'queued',request:'test',channel:'overlord'}}},save(){}};let runs=0;const replies=[];
 const bridge=new CodexBridge(q,async()=>{runs++;return 'Finished';});bridge.config={enabled:true};
 await bridge.tick(async(g,b)=>replies.push(b));assert.equal(runs,1);assert.equal(q.data.codexRequests.one.status,'complete');
 await bridge.tick(async(g,b)=>replies.push(b));await bridge.tick(async(g,b)=>replies.push(b));assert.equal(replies.length,1);assert.equal(runs,1);
});
test('failed jobs are reported and interrupted jobs never silently rerun',async()=>{
 const q={directory:'missing-test-folder',data:{codexRequests:{one:{status:'running',channel:'overlord'}}},save(){}};
 const bridge=new CodexBridge(q,async()=>{throw Error('Must not run');});bridge.config={enabled:true};await bridge.tick(async()=>{});assert.equal(q.data.codexRequests.one.status,'interrupted');
 q.data.codexRequests.two={status:'queued',channel:'overlord'};await bridge.tick(async()=>{});assert.equal(q.data.codexRequests.two.status,'failed');
});
test('runner never auto approves, bypasses sandbox, or shells request text',()=>{
 const source=readFileSync(new URL('./codex-bridge.mjs',import.meta.url),'utf8');assert.match(source,/approval_policy="on-request"/);assert.match(source,/workspace-write/);assert.match(source,/shell:false/);assert.doesNotMatch(source,/--approve-for-me|--dangerously-bypass/);
});
