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
});
