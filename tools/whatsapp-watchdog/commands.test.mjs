import test from 'node:test';
import assert from 'node:assert/strict';
import {OverlordCommands} from './commands.mjs';
test('only approved Overlord commands respond once across restarts',async()=>{
 const q={data:{reviewAlerts:{groupId:'overlord'}},save(){},reviewInbox(){return []}};
 const c=new OverlordCommands(q),sent=[],send=async(g,b)=>sent.push(b);
 const m={id:'one',channel:'overlord',timestamp:Date.now()/1000+1,body:'Watchdog: status',senderId:'24240845779152@lid'};
 await c.receive({...m,channel:'route'},send,{});await c.receive({...m,senderId:'other'},send,{});assert.equal(sent.length,0);
 await c.receive(m,send,{state:'Connected',paused:false,transportStatus:'Ready'});await c.receive(m,send,{});assert.equal(sent.length,1);assert.match(sent[0],/Connected/);
 await new OverlordCommands(q).receive(m,send,{});assert.equal(sent.length,1);
 await c.receive({...m,id:'old',timestamp:1},send,{});assert.equal(sent.length,1);
 await c.receive({...m,id:'unknown',body:'Watchdog: do something arbitrary'},send,{});assert.match(sent[1],/Request saved for Codex/);assert.equal(q.data.codexRequests.unknown.request,'do something arbitrary');assert.doesNotMatch(sent[1],/Quick commands/);
 await c.receive({...m,id:'help',body:'Watchdog: QC list'},send,{});assert.match(sent[2],/Quick commands/);
 await c.receive({...m,id:'singular-help',body:'Watchdog: quick command'},send,{});assert.match(sent[3],/Quick commands/);
});

test('free-text queues when enabled and is never interpreted as a shell command',async()=>{
 const q={data:{reviewAlerts:{groupId:'overlord'}},save(){},reviewInbox(){return []}};
 const c=new OverlordCommands(q,{config:{enabled:true}}),sent=[];
 const m={id:'free',channel:'overlord',timestamp:Date.now()/1000+1,body:'Watchdog: latest pull compare against prediction; echo example',senderId:'24240845779152@lid'};
 await c.receive(m,async(g,b)=>sent.push(b),{});assert.equal(q.data.codexRequests.free.status,'queued');assert.match(q.data.codexRequests.free.request,/echo example/);assert.match(sent[0],/queued for Codex/);
});
