import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {RecoveryAgent,healthSummary} from './remote-agent-core.mjs';
const command={id:'test-command-000001',action:'restart_worker',expiresAt:Date.now()+600000};
test('health payload contains no messages, QR, credentials or delivery bodies',()=>{
 const summary=healthSummary({state:'Connected',paused:false,channels:[{}],qr:'secret',messages:['private'],deliveries:{a:{status:'queued',body:'private'},b:{status:'complete'},c:{status:'review'}},lastReceiverCheck:'2026-10-23T12:00:00Z'});
 assert.equal(summary.pending,1);assert.equal(summary.reviews,1);assert.equal(summary.channels,1);assert.equal(JSON.stringify(summary).includes('private'),false);assert.equal('qr' in summary,false);assert.equal(healthSummary(null).workerReachable,false);
});
test('lost result response, duplicate command and helper restart never repeat recovery',async()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'watchdog-agent-'));let runs=0,firstResult=true,done=false;
 const sync=async payload=>{if(payload.result){assert.equal(payload.result.ok,true);if(firstResult){firstResult=false;throw Error('response lost');}done=true;}return {ok:true,command:done?null:command};};
 const options={directory,sync,health:async()=>healthSummary(null),execute:async()=>{runs++;}};
 try{
  let agent=new RecoveryAgent(options);await agent.tick();assert.equal(runs,1);
  await assert.rejects(agent.tick(),/response lost/);
  agent=new RecoveryAgent(options);await agent.tick();await agent.tick();assert.equal(runs,1);
  // A server re-delivery of the same command still cannot execute twice.
  agent.sync=async()=>({ok:true,command});await agent.tick();assert.equal(runs,1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('crash after claim is reported as interrupted without rerunning, and expiry blocks action',async()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'watchdog-agent-'));let runs=0,report;
 try{
  writeFileSync(path.join(directory,'remote-agent-ledger.json'),JSON.stringify({[command.id]:{id:command.id,action:command.action,state:'executing'}}));
  const agent=new RecoveryAgent({directory,health:async()=>healthSummary(null),execute:async()=>{runs++;},sync:async payload=>{report=payload.result;return {ok:true,command:null};}});
  await agent.tick();assert.equal(report.ok,false);assert.match(report.error,/restarted/);assert.equal(runs,0);
  agent.sync=async()=>({ok:true,command:{...command,id:'expired-command-001',expiresAt:1}});await agent.tick();assert.equal(runs,0);
  assert.equal(JSON.parse(readFileSync(agent.file,'utf8'))['expired-command-001'].result.ok,false);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('unknown commands and unconfirmed cloud responses cannot perform actions or clear results',async()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'watchdog-agent-'));let runs=0;
 try{
  const agent=new RecoveryAgent({directory,health:async()=>healthSummary(null),execute:async()=>{runs++;},sync:async()=>({ok:true,command:{...command,action:'run_shell'}})});
  await assert.rejects(agent.tick(),/Invalid remote/);assert.equal(runs,0);
  agent.sync=async()=>({ok:true,command});await agent.tick();agent.sync=async()=>({ok:false});await assert.rejects(agent.tick(),/did not confirm/);assert.equal(agent.ledger[command.id].acknowledged,undefined);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
