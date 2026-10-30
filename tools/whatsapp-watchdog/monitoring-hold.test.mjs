import test from 'node:test';
import assert from 'node:assert/strict';
import {heldReportAllowed} from './monitoring-hold.mjs';
import {Transport} from './transport.mjs';
const now=Date.now(),iso=n=>new Date(n).toISOString();
const held={wellName:'Test 2',channels:['group'],state:'held',hold:{effectiveAt:iso(now-86400000),autoResume:{mode:'next_load_or_level',armedAt:iso(now-600000)}}};
const row={id:'fresh',wellName:'Test 2',postedAt:iso(now-60000),dateTimeUTC:iso(now-60000),tankLevelFeet:12,bottomLevelFeet:10,bblsTaken:140,issues:[]};
test('held filtering excludes old, unarmed and malformed observations',()=>{
 assert.equal(heldReportAllowed([held],{channel:'group'},row,now),true);
 for(const update of [{postedAt:iso(now-700000)},{tankLevelFeet:null},{bottomLevelFeet:15},{dateTimeUTC:iso(now+600000)}])assert.equal(heldReportAllowed([held],{channel:'group'},{...row,...update},now),false);
 assert.equal(heldReportAllowed([{...held,hold:{...held.hold,autoResume:null}}],{channel:'group'},row,now),false);
});
test('first eligible report uses ordinary delivery and receipt, retry never creates another packet',async()=>{
 const old={...row,id:'old',postedAt:iso(now-700000),dateTimeUTC:iso(now-700000)};
 const queue={data:{messages:{one:{id:'one',channel:'group',chat:'synthetic fixture',notices:[],rows:[old,row]}},deliveries:{}},reparseChannels(){},save(){}};
 const t=new Transport(queue);t.secret='synthetic-only';t.config={enabled:true,enabledAt:0};t.channelOptions={group:{}};
 const calls=[];t.request=async(endpoint)=>{calls.push(endpoint);return endpoint==='getWatchdogWellLifecycleV2'?{wells:[held]}:endpoint==='ingestWatchdogPullV2'?{status:'queued',identity:'same',packetId:'same-packet'}:{status:'complete',identity:'same',packetId:'same-packet'};};
 await t.tick(false);await t.tick(false);
 assert.deepEqual(calls,['getWatchdogWellLifecycleV2','ingestWatchdogPullV2','getWatchdogPullReceiptV2']);
 assert.equal(queue.data.deliveries.fresh.status,'complete');assert.equal(queue.data.deliveries.old,undefined);
});
